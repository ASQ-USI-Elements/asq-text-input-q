/**
 * @module lib/textInputQStatModel
 * @description Model for text-input-q-stats element
*/

'use strict';

const assert     = require('assert');
const mongoose   = require('mongoose');
const Schema     = mongoose.Schema;
const ObjectId   = Schema.ObjectId;
const showViewerStates = ['self', 'all'];


let textInputQStatsSchema = new Schema({
    question : { type: ObjectId, ref:'Question' },
    showViewer : { type: String, required : true,  default: 'self', enum: showViewerStates},
    createdAt   : { type: Date, default: Date.now },
    createdBy   : { type: ObjectId, ref: 'User' },
    updatedAt   : { type: Date, default: Date.now },
    updatedBy   : { type: ObjectId, ref: 'User' }
});


module.exports = function(proxy){
  assert.ok(proxy.db, "Expecting proxy object to have a `db` property")
  assert.ok(proxy.db.model, "Expecting proxy object to have a `model` property")

  proxy.db.model('TextInputQStats', textInputQStatsSchema);
  return proxy.db.model('TextInputQStats');
}