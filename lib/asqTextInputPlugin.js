'use strict';

const ASQPlugin = require('asq-plugin');
const ObjectId = require("bson-objectid");
const Promise = require('bluebird');
const coroutine = Promise.coroutine;
const cheerio = require('cheerio');
const assert = require('assert');
const _ = require('lodash');


//http://www.w3.org/html/wg/drafts/html/master/infrastructure.html#boolean-attributes
function getBooleanValOfBooleanAttr(attrName, attrValue){
  if(attrValue === '' || attrValue === attrName){
    return true;
  }
  return false;
}

module.exports = ASQPlugin.extend({
  tagName : 'asq-text-input-q',

  hooks:{
    "parse_html"          : "parseHtml",
    "answer_submission"   : "answerSubmission",
    "presenter_connected" : "presenterConnected",
    "viewer_connected"    : "viewerConnected"
  },

  events: {
    "plugin" : "onPlugin"
  },

  init: function(){
    // init model for stats
    require('./textInputQStatsModel')(this.asq)
  },

  parseHtml: function(options){
    let $ = cheerio.load(options.html,  {
      decodeEntities: false,
      lowerCaseAttributeNames:false,
      lowerCaseTags:false,
      recognizeSelfClosing: true
    });
    let tiQuestions = [];
    let tiQStats = [];

    $(this.tagName).each(function(idx, el){
      tiQuestions.push(this.processEl($, el));
    }.bind(this));

    $('asq-text-input-q-stats').each(function(idx, el){
       let s = this.processStatsEl($, el);
       s.createdBy = s.updatedBy = options.user_id;
       tiQStats.push(s);
    }.bind(this));

    options.html = $.root().html();
    //return Promise that resolves with the (maybe modified) html
    return Promise.all([
      this.asq.db.model("Question").create(tiQuestions),
      this.asq.db.model("TextInputQStats").create(tiQStats)
      ])
    .then(function(){
      return Promise.resolve(options);
    });
    
  },

  answerSubmission: coroutine(function *answerSubmissionGen (answer){
    // make sure answer question exists
    const questionUid = answer.questionUid
    let question = yield this.asq.db.model("Question").findById(questionUid).exec(); 
    assert(question,
      'Could not find question with id' + questionUid + 'in the database');

    //make sure it's an answer for an asq-text-input-q question
    if(question.type !=='asq-text-input-q') {
      return answer;
    }

    assert(_.isString(answer.submission),
      'Invalid answer format, answer.submission should be a string.');

    //persist
    yield this.asq.db.model("Answer").create({
      exercise   : answer.exercise_id,
      question   : questionUid,
      answeree   : answer.answeree,
      session    : answer.session,
      type       : question.type,
      submitDate : Date.now(),
      submission : answer.submission,
      confidence : answer.confidence
    });

    const answers = yield this.calculateProgress(answer.session, question);
    this.sendProgressToPresenters(answer.session, question, answers);

    this.sendFeedbackToAnsweree(question, answer);
    this.checkAndSendProgressToViewers(answer.session, question, answers);

    //this will be the argument to the next hook
    return answer;
  }),
  
  calculateProgress: coroutine(function *calculateProgressGen(session_id, question){
    let pipeline = [
      { $match: {
          session: session_id,
          question : question._id
        }
      },
      {$sort:{"submitDate":-1}},
      { $group:{
          "_id":"$answeree",
          "submitDate":{$first:"$submitDate"},
          "submission": {$first:"$submission"},
        }
      }
    ]

    let answers = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    //add correctness
    answers.forEach( answer => {
      let correct;
      if(question.data.solution){
        correct = this.isSubmissionCorrect(question.data.solution.toString(), answer.submission.toString());
      }
      answer.isSubmissionCorrect = correct;
    })

    return answers;
  }),

  isSubmissionCorrect: function(solution, submission){
    let regexp = new RegExp(solution);
    return regexp.test(submission);
  },

  sendProgressToPresenters: function(session_id, question, answers){
    let event = {
      questionType: this.tagName,
      type: 'progress',
      question: {
        uid: question._id.toString(),
        answers: answers
      }
    }

    this.asq.socket.emitToRoles('asq:question_type', event, session_id.toString(), 'ctrl')
  },

  sendFeedbackToAnsweree: function(question, userAnswer){
    if(! userAnswer.socketId) return;

    let isSubmissionCorrect;
    if(question.data.solution){
      isSubmissionCorrect = this.isSubmissionCorrect(question.data.solution.toString(), userAnswer.submission.toString());
    }

    let event = {
      questionType: this.tagName,
      type: 'self-progress',
      question:{
        uid: question.id,
        data:{},
        answer: {
          submission: userAnswer.submission,
          isSubmissionCorrect
        },
      }
    }

    if(question.data.solution && !isSubmissionCorrect && question.data.hint){
      event.question.data.hint = question.data.hint;
    }

    this.asq.socket.emit('asq:question_type', event, userAnswer.socketId);
  },

  checkAndSendProgressToViewers: coroutine(
    function *checkAndSendProgressToViewersGen(session_id, question, answers){
    // see if we need to send just the viewer's solution or all of them
    // if we have even one stat for ths question that want's all of them
    // then we send all

    const cnt = yield this.asq.db.model('TextInputQStats').count({
      question: question.id,
      showViewer: "all"
    }).exec();

    if (cnt == 0) return;

    let event = {
      questionType: this.tagName,
      type: 'progress',
      question:{
        uid: question.id,
        answers: answers
      }
    }

    this.asq.socket.emitToRoles('asq:question_type', event, session_id.toString(), 'folo');
  }),

  processEl: function($, el){

    let $el = $(el);

    //make sure question has a unique id
    let uid = $el.attr('uid');
    if(uid == undefined || uid.trim() == ''){
      $el.attr('uid', uid = ObjectId().toString() );
    } 

    //get stem
    let stem = $el.find('asq-stem');
    if(stem.length){
      stem = stem.eq(0).html();
    }else{
      stem = '';
    }

    const result = {
      _id : uid,
      type: this.tagName,
      data: {
        html: $.html($el),
        stem: stem
      }
    }

    //parse solution
    const solution = this.parseSolution($, el);

    if(solution){
      result.data.solution = solution;
    }

    //parse hint
    const hint = this.parseHint($, el);

    if(hint){
      result.data.hint = hint;
    }

    return result;
  },

  processStatsEl: function($, el){

    let $el = $(el);

    //make sure question has a unique id
    let qid = $el.attr('for');
    if(qid == undefined || qid.trim() == ''){
      return;
    }

    //find related question
    let $q = $('#' + qid);

    //make sure it's an asq-text-input-q question
    if($q.get(0).tagName.toLowerCase() != this.tagName){
      return;
    }

    //set for-uid attribute
    let quid = $q.attr('uid');
    // something's wrong here
    if(quid == undefined || quid.trim() == ''){
      return;
    } 
    $el.attr('for-uid', quid);

    const showViewer = $el.attr('show-viewer') || "self";

    return {
      question: ObjectId(quid),
      showViewer: showViewer
    }
  },

  parseSolution: function($, el){
    let $el = $(el);

    let solution = null;
    let $solution = $el.find('asq-solution').eq(0);
    if($solution){
      solution = $solution.text();
    }  

    //remove all solution elements so that they don't get served in HTML
    $el.find('asq-solution').remove();
    
    return solution;
  },

  parseHint: function($, el){
    let $el = $(el);

    let hint = null;
    let $hint = $el.find('asq-hint').eq(0);
    if($hint){
      hint = $hint.html();
    }  

    //remove all hint elements so that they don't get served in HTML
    $el.find('asq-hint').remove();
    
    return hint;
  },

  getMostRecentAnswersForQuestions: function(session_id, questionIds){

    let pipeline = [
      { $match: {
          session: session_id,
          "question" : {$in : questionIds}
        }
      },
      { $sort:{"submitDate": -1}},
      { $group:{
          "_id":{
            "answeree" : "$answeree",
            "question" : "$question"
          },
          "submitDate":{$first:"$submitDate"},
          "submission": {$first:"$submission"},
        }
      },
      { $group:{
          "_id": {
            "question" : "$_id.question",
          },
          "submissions": {$push: {
            "_id" : "$_id.answeree" ,
            "submitDate": "$submitDate", 
            "submission": "$submission" 
          }}
        }
      },
      { $project : { 
          "_id": 0,
          "question" : "$_id.question",
          "submissions" : 1
        } 
      }
    ]
    return this.asq.db.model('Answer').aggregate(pipeline).exec();
  },

  restorePresenterForSession: coroutine(function *restorePresenterForSessionGen(session_id, presentation_id){
    
    let questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    let questionIds = questions.map(function(q){
      return q._id;
    });

    let answers = yield this.getMostRecentAnswersForQuestions(session_id, questionIds);

    questions.forEach(function(q){
      q.uid = q._id.toString();
      q.answers = [];
      for(let i=0, l=answers.length; i<l; i++){
        if(answers[i].question.toString() == q._id){
          q.answers = answers[i].submissions
          q.answers.forEach(function(answer){
            let correct;
            if(q.data.solution){
              correct = (q.data.solution.toString() ===  answer.submission.toString())
            }
            answer.isSubmissionCorrect = correct;
          });
          break;
        }
      }
    });

    return questions;    
  }),

  presenterConnected: coroutine(function *presenterConnectedGen (info){

    if(! info.session_id) return info;

    const questionsWithSubmissions = yield this.restorePresenterForSession(info.session_id, info.presentation_id);

    const event = {
      questionType: this.tagName,
      type: 'restorePresenter',
      questions: questionsWithSubmissions
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)

    //this will be the argument to the next hook
    return info;
  }),

  restoreViewerForSession: coroutine(function *restoreViewerForSessionGen(session_id, presentation_id, whitelistId){
    let questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    let questionIds = questions.map(function(q){
      return q._id;
    });

    let answers = yield this.getMostRecentAnswersForQuestions(session_id, questionIds);
    
    questions.forEach(function(q){
      q.uid = q._id.toString();
      q.answers = [];
      
      // cache data
      const questionData = q.data;
      // reset q.data so that we just send the information that's needed
      q.data = {};

      for(let i=0, l=answers.length; i<l; i++){
        if(answers[i].question.toString() == q._id){
          q.answers = answers[i].submissions
          q.answers.forEach(function(answer){            

            if(answer._id.toString() === whitelistId.toString()){
              let correct;
              if(questionData.solution){
                correct = (questionData.solution.toString() ===  answer.submission.toString())
              }
              answer.isSubmissionCorrect = correct;

              if(questionData.solution && !correct && questionData.hint){
                q.data.hint = questionData.hint;
              }

             q.ownAnswer = answer;
            }
          });
          break;
        }
      }
    })
    
    // let pipeline = [
    //   { $match: {
    //       "session": session_id,
    //       "answeree" : whitelistId,
    //       "question" : {$in : questionIds}
    //     }
    //   },
    //   { $sort:{"submitDate": -1}},
    //   { $group:{
    //       "_id": "$question",
    //       "submission": {$first:"$submission"},
    //     }
    //   },
    //   { $project:{
    //       "_id": 0,
    //       "question" : "$_id",
    //       "submission": 1,
    //     }
    //   }
    // ]
    // let ownAnswers = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    // questions.forEach(function(q){
    //   q.uid = q._id.toString();
    //   q.ownAnswer = {};
    //   for(let i=0, l=ownAnswers.length; i<l; i++){
    //     if(ownAnswers[i].question.toString() == q._id){
    //       q.ownAnswer.submission = ownAnswers[i].submission;

    //       let correct;
    //       if(q.data.solution){
    //         correct = (q.data.solution.toString() ===  q.ownAnswer.submission.toString())
    //       }
    //       q.ownAnswer.isSubmissionCorrect = correct;
    //       break;
    //     }
    //   }
    // })

    return questions;    
  }),

  viewerConnected: coroutine(function *viewerConnectedGen (info){

    if(! info.session_id) return info;

    const questionsWithAnswers = yield this.restoreViewerForSession(info.session_id, info.presentation_id, info.whitelistId);

    const event = {
      questionType: this.tagName,
      type: 'restoreViewer',
      questions: questionsWithAnswers
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)

    // this will be the argument to the next hook
    return info;
  }),

  onPlugin: function(evt){
    if(! evt.sessionId || evt.questionType !== this.tagName) return;

    switch(evt.type){
      case 'quiztimedout' :
        this.quizTimedOut(evt)
        break;
    }
  },

  quizTimedOut: coroutine(function *quizTimedOutGen (evt){

    const questionUid = evt.questionUid
    let question = yield this.asq.db.model("Question").findById(questionUid).exec(); 
    assert(question,
      'Could not find question with id' + questionUid + 'in the database');

    //make sure it's an asq-text-input-q question
    if(question.type !== this.tagName) {
      return;
    }

    let responseEvent = {
     questionType: this.tagName,
     type: 'show-hint-quiztimedout',
     question:{
       uid: question.id,
       data:{},
      }
    };

    if(question.data.solution && question.data.hint){
     responseEvent.question.data.hint = question.data.hint;
    }

    this.asq.socket.emit('asq:question_type', responseEvent, evt.socketId);
  }),
});