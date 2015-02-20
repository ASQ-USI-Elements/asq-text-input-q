"use strict";

var chai = require('chai');
var sinon = require("sinon");
var should = chai.should();
var expect = chai.expect;
var cheerio = require('cheerio');
var Promise = require('bluebird');
var modulePath = "../../lib/asqTextInputPlugin";
var fs = require("fs");

describe("asqTextInputPlugin.js", function(){
  
  before(function(){
    var then =  this.then = function(cb){
      return cb();
    };

    var create = this.create = sinon.stub().returns({
      then: then
    });

    this.tagName = "asq-text-input";

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
    
    this.asqTextInputPlugin = require(modulePath);
  });

   describe("parseHtml", function(){

    before(function(){
     sinon.stub(this.asqTextInputPlugin.prototype, "processEl").returns("res");
    });

    beforeEach(function(){
      this.asqti = new this.asqTextInputPlugin(this.asq);
      this.asqTextInputPlugin.prototype.processEl.reset();
      this.create.reset();
    });

    after(function(){
      this.asqTextInputPlugin.prototype.processEl.restore();
    });

    it("should call processEl() for all asq-text-input elements", function(done){
      this.asqti.parseHtml(this.simpleHtml)
      .then(function(){
        this.asqti.processEl.calledTwice.should.equal(true);
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

    it("should call `model().create()` to persist parsed questions in the db", function(done){
      this.asqti.parseHtml(this.simpleHtml)
      .then(function(result){
        this.create.calledOnce.should.equal(true);
        this.create.calledWith(["res", "res"]).should.equal(true);
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

    it("should resolve with the file's html", function(done){
      this.asqti.parseHtml(this.simpleHtml)
      .then(function(result){
        expect(result).to.equal(this.simpleHtml);
        done();
      }.bind(this))
      .catch(function(err){
        done(err)
      })
    });

  });

  describe("processEl", function(){

    before(function(){
     sinon.stub(this.asqTextInputPlugin.prototype, "parseSolution").returns("sol");
    });

    beforeEach(function(){
      this.asqti = new this.asqTextInputPlugin(this.asq);
      this.asqTextInputPlugin.prototype.parseSolution.reset();
    });

    after(function(){
     this.asqTextInputPlugin.prototype.parseSolution.restore();
    });

    it("should assign a uid to the question if there's not one", function(){
      var $ = cheerio.load(this.simpleHtml);
      
      //this doesn't have an id
      var el = $("#no-uid")[0];
      this.asqti.processEl($, el);
      $(el).attr('uid').should.exist;
      $(el).attr('uid').should.not.equal("a-uid");

      //this already has one
      el = $("#uid")[0];
      this.asqti.processEl($, el);
      $(el).attr('uid').should.exist;
      $(el).attr('uid').should.equal("a-uid");
    });

    it("should call parseSolution()", function(){
      var $ = cheerio.load(this.simpleHtml);
      var el = $(this.tagName)[0];

      this.asqti.processEl($, el);
      this.asqti.parseSolution.calledOnce.should.equal(true);
    });

    it("should find the stem if it exists", function(){
      var $ = cheerio.load(this.simpleHtml);
      var el = $("#no-uid")[0];
      var elWithHtmlInStem = $("#uid")[0];

      var result = this.asqti.processEl($, el);
      expect(result.data.stem).to.equal("This is a stem");

      var result = this.asqti.processEl($, elWithHtmlInStem);
      expect(result.data.stem).to.equal("<h2>What&apos;s the root of 9?</h2>");


      var $ = cheerio.load(this.noStemHtml);
      var el = $("#no-uid")[0];
      var result = this.asqti.processEl($, el);
      expect(result.data.stem).to.equal("");


    });

    it("should return correct data", function(){
      var $ = cheerio.load(this.simpleHtml);
      var el = $("#uid")[0];

      var result = this.asqti.processEl($, el);
      expect(result._id).to.equal("a-uid");
      expect(result.type).to.equal(this.tagName);
      expect(result.data.stem).to.equal("<h2>What&apos;s the root of 9?</h2>");
      expect(result.data.solution).to.equal("sol");
    });
  });

  describe("parseSolution", function(){

    beforeEach(function(){
      this.$ = cheerio.load(this.solutionsHtml);
      this.asqti = new this.asqTextInputPlugin(this.asq);
    });

    it("should delete the 'asq-solution' after parsing", function(){
      var el = this.$("#uid")[0];
      var result = this.asqti.parseSolution(this.$, el);
      var sol = this.$(el).find("asq-solution").length;
      expect(sol).to.equal(0);

    });

    it("should return the correct data", function(){
      var el = this.$("#uid")[0];
      var result = this.asqti.parseSolution(this.$, el);
      expect(result).to.equal("x");

    });

    it("should have more than two soltions before parsing", function(){
      var el = this.$("#uid")[0];
      var sol = this.$(el).find("asq-solution").length;
      expect(sol).to.equal(1);

    });

  });
});
