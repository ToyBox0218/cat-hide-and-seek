'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Status=require('../status-presenter.js');

function node(){
  const attributes=new Map(),classes=new Set();
  return{textContent:'',dataset:{},hidden:false,classList:{toggle(name,on){on?classes.add(name):classes.delete(name)},contains:name=>classes.has(name)},getAttribute:name=>attributes.get(name)||null,setAttribute(name,value){attributes.set(name,String(value))}};
}

test('shared status presenter owns ARIA defaults and deduplicates unchanged messages',()=>{
  const target=node();assert.equal(Status.present(target,'Ready'),true);
  assert.equal(target.getAttribute('role'),'status');assert.equal(target.getAttribute('aria-live'),'polite');assert.equal(target.getAttribute('aria-atomic'),'true');
  assert.equal(Status.present(target,'Ready'),false);assert.equal(Status.present(target,'Ready',{key:'new-event'}),true);
});

test('shared status presenter supports hidden state, clearing and missing containers',()=>{
  const target=node();Status.present(target,'Waiting',{hidden:true});assert.equal(target.hidden,true);assert.equal(target.classList.contains('hidden'),true);
  assert.equal(Status.clear(target,{hidden:false}),true);assert.equal(target.textContent,'');assert.equal(target.hidden,false);assert.equal(Status.present(null,'Ignored'),false);
});
