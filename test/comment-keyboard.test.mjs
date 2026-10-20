import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldSubmitComment} from '../src/feedback-data.mjs';

const enter={key:'Enter',keyCode:13,shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,isComposing:false,repeat:false};
const shortcuts=[{}, {ctrlKey:true}, {metaKey:true}, {ctrlKey:true,metaKey:true}];

test('plain Enter and Ctrl/Cmd+Enter submit a comment',()=>{
  for(const shortcut of shortcuts)assert.equal(shouldSubmitComment({...enter,...shortcut}),true);
});

test('Shift+Enter preserves the newline shortcut, including with Ctrl/Cmd',()=>{
  for(const shortcut of shortcuts)assert.equal(shouldSubmitComment({...enter,...shortcut,shiftKey:true}),false);
});

test('Alt+Enter does not submit, including with Ctrl/Cmd',()=>{
  for(const shortcut of shortcuts)assert.equal(shouldSubmitComment({...enter,...shortcut,altKey:true}),false);
});

test('Enter during IME composition does not submit',()=>{
  for(const shortcut of shortcuts)assert.equal(shouldSubmitComment({...enter,...shortcut,isComposing:true}),false);
});

test('legacy IME keyCode 229 does not submit even after isComposing clears',()=>{
  for(const shortcut of shortcuts)assert.equal(shouldSubmitComment({...enter,...shortcut,keyCode:229,isComposing:false}),false);
});

test('holding Enter does not submit again on repeated keydown',()=>{
  for(const shortcut of shortcuts)assert.equal(shouldSubmitComment({...enter,...shortcut,repeat:true}),false);
});

test('keys other than Enter do not submit, including with Ctrl/Cmd',()=>{
  for(const key of ['a','Escape','Tab','Process']){
    for(const shortcut of shortcuts)assert.equal(shouldSubmitComment({...enter,...shortcut,key,keyCode:0}),false);
  }
});
