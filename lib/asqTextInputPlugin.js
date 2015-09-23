var ASQPlugin = require('asq-plugin');
var ObjectId = require("bson-objectid");
var Promise = require('bluebird');
var coroutine = Promise.coroutine;
var cheerio = require('cheerio');
var assert = require('assert');
var _ = require('lodash');


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

  parseHtml: function(option){
    var $ = cheerio.load(option.html, {decodeEntities: false});
    var tiQuestions = [];

    $(this.tagName).each(function(idx, el){
      tiQuestions.push(this.processEl($, el));
    }.bind(this));

    $('asq-text-input-q-stats').each(function(idx, el){
      this.processStatsEl($, el);
    }.bind(this));

    option.html = $.root().html();
    //return Promise that resolves with the (maybe modified) html
    return this.asq.db.model("Question").create(tiQuestions)
    .then(function(){
      return Promise.resolve(option);
    });
    
  },

  answerSubmission: coroutine(function *answerSubmissionGen (answer){
    // make sure answer question exists
    var questionUid = answer.questionUid
    var question = yield this.asq.db.model("Question").findById(questionUid).exec(); 
    assert(question,
      'Could not find question with id' + questionUid + 'in the database');

    //make sure it's an answer for a multi-choice question
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

    this.calculateProgress(answer.session, ObjectId(questionUid));
    this.sendViewerFeedback(question, answer)

    //this will be the argument to the next hook
    return answer;
  }),
  
  calculateProgress: coroutine(function *calculateProgressGen(session_id, question_id){
    var criteria = {session: session_id, question:question_id};
    var pipeline = [
      { $match: {
          session: session_id,
          question : question_id
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

    var answers = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    var event = {
      questionType: this.tagName,
      type: 'progress',
      question: {
        uid: question_id.toString(),
        answers: answers,
      }
    }

    this.asq.socket.emitToRoles('asq:question_type', event, session_id.toString(), 'ctrl')
  }),

  sendViewerFeedback: function(question, answer){
    if(! answer.socketId) return;
    
    var correct;
    if(question.data.solution){
      correct = (question.data.solution.toString() === answer.submission.toString())
    }

    var event = {
      questionType: this.tagName,
      type: 'progress',
      question:{
        uid: question.id,
        answer: {
          submission: answer.submission,
          isSubmissionCorrect: correct
        }
      }
    }

    this.asq.socket.emit('asq:question_type', event, answer.socketId)
  },

  processEl: function($, el){

    var $el = $(el);

    //make sure question has a unique id
    var uid = $el.attr('uid');
    if(uid == undefined || uid.trim() == ''){
      $el.attr('uid', uid = ObjectId().toString() );
    } 

    //get stem
    var stem = $el.find('asq-stem');
    if(stem.length){
      stem = stem.eq(0).html();
    }else{
      stem = '';
    }

    //parse solution
    var solution = this.parseSolution($, el);

    return {
      _id : uid,
      type: this.tagName,
      data: {
        stem: stem,
        solution : solution
      }
    }
  },

  processStatsEl: function($, el){

    var $el = $(el);

    //make sure question has a unique id
    var qid = $el.attr('for');
    if(qid == undefined || qid.trim() == ''){
      return;
    }

    //find related question
    var $q = $('#' + qid);

    //make sure it's an asq-text-input-q question
    if($q.get(0).tagName.toLowerCase() != this.tagName){
      return;
    }

    //set for-uid attribute
    var quid = $q.attr('uid');
    // something's wrong here
    if(quid == undefined || quid.trim() == ''){
      return;
    } 
    $el.attr('for-uid', quid);
  },

  parseSolution: function($, el){
    var $el = $(el);

    var solution = {};
    var $solution = $el.find('asq-solution').eq(0);
    if($solution){
      solution = $solution.text();
    }  
    
    //remove solution element so that it doesn't get served in HTML
    $solution.remove();
    
    return solution;
  },


  restorePresenterForSession: coroutine(function *restorePresenterForSessionGen(session_id, presentation_id){
    
    var questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    var questionIds = questions.map(function(q){
      return q._id;
    });

    var pipeline = [
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
    var submissions = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    questions.forEach(function(q){
      q.uid = q._id.toString();
      q.answers = [];
      for(var i=0, l=submissions.length; i<l; i++){
        if(submissions[i].question.toString() == q._id){
          q.answers = submissions[i].submissions
          break;
        }
      }
    });

    return questions;    
  }),

  presenterConnected: coroutine(function *presenterConnectedGen (info){

    if(! info.session_id) return info;

    var questionsWithSubmissions = yield this.restorePresenterForSession(info.session_id, info.presentation_id);

    var event = {
      questionType: this.tagName,
      type: 'restorePresenter',
      questions: questionsWithSubmissions
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)

    //this will be the argument to the next hook
    return info;
  }),

  restoreViewerForSession: coroutine(function *restoreViewerForSessionGen(session_id, presentation_id, whitelistId){
    var questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    var questionIds = questions.map(function(q){
      return q._id;
    });

    var pipeline = [
      { $match: {
          "session": session_id,
          "answeree" : whitelistId,
          "question" : {$in : questionIds}
        }
      },
      { $sort:{"submitDate": -1}},
      { $group:{
          "_id": "$question",
          "submission": {$first:"$submission"},
        }
      },
      { $project:{
          "_id": 0,
          "question" : "$_id",
          "submission": 1,
        }
      }
    ]
    var submissions = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    questions.forEach(function(q){
      q.uid = q._id.toString();
      q.answer = {};
      for(var i=0, l=submissions.length; i<l; i++){
        if(submissions[i].question.toString() == q._id){
          q.answer.submission = submissions[i].submission;

          var correct;
          if(q.data.solution){
            correct = (q.data.solution.toString() ===  q.answer.submission.toString())
          }
          q.answer.isSubmissionCorrect = correct;
          break;
        }
      }
    })

    return questions;    
  }),

  viewerConnected: coroutine(function *viewerConnectedGen (info){

    if(! info.session_id) return info;

    var questionsWithAnswers = yield this.restoreViewerForSession(info.session_id, info.presentation_id, info.whitelistId);

    var event = {
      questionType: this.tagName,
      type: 'restoreViewer',
      questions: questionsWithAnswers
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)

    return info;
  }),


});