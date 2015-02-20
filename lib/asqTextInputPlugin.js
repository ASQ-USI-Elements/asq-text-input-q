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
    "parse_html" : "parseHtml",
    "answer_submission" : "answerSubmission",
    // "receivedAnswer" : receivedAnswer,
    // "autoAssess" : autoAssess 
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

    // make sure submission is an array
    answer.submission
    assert(_.isObject(answer.submission),
      'Invalid answer format, answer.submission should be an object.');

    //persist
    yield this.asq.db.model("Answer").create({
      exercise   : answer.exercise_id,
      question   : questionUid,
      answeree   : answer.answeree,
      session    : answer.session,
      submitDate : Date.now(),
      submission : answer.submission,
      confidence : answer.confidence
    });

    this.calculateProgress(answer.session, ObjectId(questionUid));

    //this will be the argument to the next hook
    return answer;
  }),

  calculateProgress: coroutine(function *calculateProgressGen(session_id, question_id){
    var criteria = {session: session_id, question:question_id};
    var answers = yield this.asq.db.model('Answer').find(criteria).lean().exec();

    var heatmapData = answers.map(function(answer){
      return answer.submission;
    });

    var event = {
      questionType: this.tagName,
      type: 'progress',
      questionUid: question_id.toString(),
      heatmapData: JSON.stringify(heatmapData),
    }

    this.asq.command('sendSocketEventToNamespaces', 'asq:question_type', event, session_id.toString(), 'ctrl')
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
  }

});