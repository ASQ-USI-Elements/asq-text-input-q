'use strict';

var chai = require('chai');
var sinon = require('sinon');
var should = chai.should();
var expect = chai.expect;
var cheerio = require('cheerio');
var Promise = require('bluebird');
var modulePath = '../../lib/asqTextInputPlugin';
var fs = require('fs');

describe('asqTextInputPlugin.js', function(){
  
  before(function(){
    var then =  this.then = function(cb){
      return cb();
    };

    var create = this.create = sinon.stub().returns({
      then: then
    });

    this.tagName = 'asq-text-input-q';

    this.asq = {
      registerHook: function(){},
      db: {
        model: function(){
          return {
            create: create
          }
        }
      }
    }

    //load html fixtures
    this.simpleHtml = fs.readFileSync(require.resolve('./fixtures/simple.html'), 'utf-8');
    this.noStemHtml = fs.readFileSync(require.resolve('./fixtures/no-stem.html'), 'utf-8');
    this.solutionsHtml = fs.readFileSync(require.resolve('./fixtures/solutions.html'), 'utf-8');
    this.hintsHtml = fs.readFileSync(require.resolve('./fixtures/hints.html'), 'utf-8');
    
    this.asqTextInputPlugin = require(modulePath);
  });

   describe('parseHtml', function(){

    before(function(){
     sinon.stub(this.asqTextInputPlugin.prototype, 'processEl').returns('res');
    });

    beforeEach(function(){
      this.asqti = new this.asqTextInputPlugin(this.asq);
      this.asqTextInputPlugin.prototype.processEl.reset();
      this.create.reset();
    });

    after(function(){
      this.asqTextInputPlugin.prototype.processEl.restore();
    });

    it('should call processEl() for all asq-text-input-q elements', function(done){
      this.asqti.parseHtml({ html: this.simpleHtml })
      .then(function(){
        this.asqti.processEl.calledTwice.should.equal(true);
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

    it('should call `model().create()` to persist parsed questions in the db', function(done){
      this.asqti.parseHtml({ html: this.simpleHtml })
      .then(function(result){
        // it should be called twice: once for questions and once for stats
        this.create.calledTwice.should.equal(true);
        this.create.calledWith(['res', 'res']).should.equal(true);
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

    it('should resolve with the file\'s html', function(done){
      this.asqti.parseHtml({ html: this.simpleHtml })
      .then(function(result){
        expect(result).to.deep.equal({ html: this.simpleHtml });
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

  });

  describe('processEl', function(){

    before(function(){
     sinon.stub(this.asqTextInputPlugin.prototype, 'parseSolution').returns('sol');
     sinon.stub(this.asqTextInputPlugin.prototype, 'parseHint').returns('hint');
    });

    beforeEach(function(){
      this.asqti = new this.asqTextInputPlugin(this.asq);
      this.asqTextInputPlugin.prototype.parseSolution.reset();
    });

    after(function(){
     this.asqTextInputPlugin.prototype.parseSolution.restore();
     this.asqTextInputPlugin.prototype.parseHint.restore();
    });

    it('should assign a uid to the question if there\'s not one', function(){
      var $ = cheerio.load(this.simpleHtml);
      
      //this doesn't have an id
      var el = $('#no-uid')[0];
      this.asqti.processEl($, el);
      $(el).attr('uid').should.exist;
      $(el).attr('uid').should.not.equal('a-uid');

      //this already has one
      el = $('#uid')[0];
      this.asqti.processEl($, el);
      $(el).attr('uid').should.exist;
      $(el).attr('uid').should.equal('a-uid');
    });

    it('should call parseSolution()', function(){
      var $ = cheerio.load(this.simpleHtml);
      var el = $(this.tagName)[0];

      this.asqti.processEl($, el);
      this.asqti.parseSolution.calledOnce.should.equal(true);
    });

    it('should find the stem if it exists', function(){
      var $ = cheerio.load(this.simpleHtml);
      var el = $('#no-uid')[0];
      var elWithHtmlInStem = $('#uid')[0];

      var result = this.asqti.processEl($, el);
      expect(result.data.stem).to.equal('This is a stem');

      var result = this.asqti.processEl($, elWithHtmlInStem);
      expect(result.data.stem).to.equal('<h2>What&apos;s the root of 9?</h2>');


      var $ = cheerio.load(this.noStemHtml);
      var el = $('#no-uid')[0];
      var result = this.asqti.processEl($, el);
      expect(result.data.stem).to.equal('');


    });

    it('should return correct data', function(){
      var $ = cheerio.load(this.simpleHtml);
      var el = $('#uid')[0];

      var result = this.asqti.processEl($, el);
      expect(result._id).to.equal('a-uid');
      expect(result.type).to.equal(this.tagName);
      expect(result.data.stem).to.equal('<h2>What&apos;s the root of 9?</h2>');
      expect(result.data.solution).to.equal('sol');
      expect(result.data.hint).to.equal('hint');
    });
  });

  describe('parseSolution', function(){

    beforeEach(function(){
      this.$ = cheerio.load(this.solutionsHtml);
      this.asqti = new this.asqTextInputPlugin(this.asq);
    });

    it('should delete the <asq-solution> after parsing', function(){
      var el = this.$('#uid')[0];
      var result = this.asqti.parseSolution(this.$, el);
      var sol = this.$(el).find('asq-solution').length;
      expect(sol).to.equal(0);
    });

    it('should delete all <asq-solution> elements after parsing', function(){
      var el = this.$('#two-solutions')[0];
      var sol = this.$(el).find('asq-solution').length;
      expect(sol).to.equal(2);
      var result = this.asqti.parseSolution(this.$, el);
      sol = this.$(el).find('asq-solution').length;
      expect(sol).to.equal(0);
    });

    it('should return the correct data', function(){
      var el = this.$('#uid')[0];
      var result = this.asqti.parseSolution(this.$, el);
      expect(result).to.equal('le solution');
    });

    it('should store only the first <asq-solution> element', function(){
      var el = this.$('#two-solutions')[0];
      var result = this.asqti.parseSolution(this.$, el);
      expect(result).to.equal('le solution 1');
    });
  });

  describe('parseHint', function(){

    beforeEach(function(){
      this.$ = cheerio.load(this.hintsHtml);
      this.asqti = new this.asqTextInputPlugin(this.asq);
    });

    it('should delete one <asq-hint> after parsing', function(){
      var el = this.$('#uid')[0];
      var result = this.asqti.parseHint(this.$, el);
      var hint = this.$(el).find('asq-hint').length;
      expect(hint).to.equal(0);
    });

    it('should delete all <asq-hint> elements after parsing', function(){
      var el = this.$('#two-hints')[0];
      var hint = this.$(el).find('asq-hint').length;
      expect(hint).to.equal(2);
      var result = this.asqti.parseHint(this.$, el);
      hint = this.$(el).find('asq-hint').length;
      expect(hint).to.equal(0);
    });

    it('should return the correct data', function(){
      var el = this.$('#uid')[0];
      var result = this.asqti.parseHint(this.$, el);
      expect(result).to.equal('<div>le hint</div>');
    });

    it('should store only the first <asq-hint> element', function(){
      var el = this.$('#two-hints')[0];
      var result = this.asqti.parseHint(this.$, el);
      expect(result).to.equal('<div>le hint 1</div>');
    });

  });

  describe('isSubmissionCorrect', function(){
    beforeEach(function(){
      this.asqti = new this.asqTextInputPlugin(this.asq);
    });

    it('should return true if submission matches string solution', function(){
      this.asqti.isSubmissionCorrect('test', 'test').should.equal(true)
    })
    it('should return true if submissions matches regex solution', function(){
      this.asqti.isSubmissionCorrect('^test$', 'test').should.equal(true)
    })
    it('should return false if submission doesn\'t match string solution', function(){
      this.asqti.isSubmissionCorrect('test', 'unmatch').should.equal(false)
    })
    it('should return true if submission doesn\'t match regex solution', function(){
      this.asqti.isSubmissionCorrect('^test$', 'testtest').should.equal(false)
    })
  });

  describe('answerSubmission', function(){
    it.skip('TODO: write tests for this')
  });
  describe('calculateProgress', function(){
    it.skip('TODO: write tests for this')
  });
  describe('sendProgressToPresenters', function(){
    it.skip('TODO: write tests for this')
  });
  describe('sendFeedbackToAnsweree', function(){
    it.skip('TODO: write tests for this')
  });
  describe('checkAndSendProgressToViewers', function(){
    it.skip('TODO: write tests for this')
  });
  describe('processStatsEl', function(){
    it.skip('TODO: write tests for this')
  });
  describe('getMostRecentAnswersForQuestions', function(){
    it.skip('TODO: write tests for this')
  });
  describe('restorePresenterForSession', function(){
    it.skip('TODO: write tests for this')
  });
  describe('presenterConnected', function(){
    it.skip('TODO: write tests for this')
  });
  describe('restoreViewerForSession', function(){
    it.skip('TODO: write tests for this')
  });
  describe('viewerConnected', function(){
    it.skip('TODO: write tests for this')
  });

});
