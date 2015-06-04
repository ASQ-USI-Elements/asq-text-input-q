var ASQPlugin = require('asq-plugin');
var ObjectId = require('mongoose').Types.ObjectId;
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
  tagName : 'asq-text-input',

  hooks:{
    "parse_html"          : "parseHtml",
    "answer_submission"   : "answerSubmission",
    "presenter_connected" : "presenterConnected",
    "viewer_connected"    : "viewerConnected"
  },

  parseHtml: function(html){
    var $ = cheerio.load(html, {decodeEntities: false});
    var tiQuestions = [];

    $(this.tagName).each(function(idx, el){
      tiQuestions.push(this.processEl($, el));
    }.bind(this));

    //return Promise that resolves with the (maybe modified) html
    return this.asq.db.model("Question").create(tiQuestions)
    .then(function(){
      return Promise.resolve($.root().html());
    });
    
  },

  answerSubmission: coroutine(function *answerSubmissionGen (answer){
    // make sure answer question exists
    var questionUid = answer.questionUid
    var question = yield this.asq.db.model("Question").findById(questionUid).exec(); 
    assert(question,
      'Could not find question with id' + questionUid + 'in the database');

    //make sure it's an answer for a multi-choice question
    if(question.type !=='asq-text-input') {
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

    console.log('when submitted: ', answer.submission);

    //this will be the argument to the next hook
    return answer;
  }),

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


  // keep empty
  restorePresenterForSession: coroutine(function *restorePresenterForSessionGen(session_id, presentation_id){
    return null;    
  }),

  // keep empty
  presenterConnected: coroutine(function *presenterConnectedGen (info){

    if(! info.session_id) return info;

    var questionsWithScores = yield this.restorePresenterForSession(info.session_id, info.presentation_id);

    var event = {
      questionType: this.tagName,
      type: 'restorePresenter',
      questions: questionsWithScores,
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
      { $sort:{"submitDate": -1} },
      { $group:{
          "_id": "$question",
          "value": {$first:"$submission"},
        }
      },
      { $project:{
          "_id": 0,
          "uid" : "$_id",
          "value": 1,
        }
      }

    ]
    var questionsWithAnswers = yield this.asq.db.model('Answer').aggregate(pipeline).exec();
    console.log('h', questionsWithAnswers);

    return questionsWithAnswers;    
  }),
  
  viewerConnected: coroutine(function *viewerConnectedGen (info){
    
    if(! info.session_id) return info;
    console.log('viewerConnected');
    var questionsWithAnswers = yield this.restoreViewerForSession(info.session_id, info.presentation_id, info.whitelistId);

    var event = {
      questionType: this.tagName,
      type: 'restoreViewer',
      questions: questionsWithAnswers
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)
    // this will be the argument to the next hook
    return info;
  }),


});