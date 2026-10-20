import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isAskForChangeShortcut,placeSelectionPopup} from '../src/feedback-data.mjs';

test('reference shortcut and legacy shortcut both open the inline editor',()=>{
  assert.equal(isAskForChangeShortcut({key:'X',ctrlKey:true,shiftKey:true}),true);
  assert.equal(isAskForChangeShortcut({key:'x',metaKey:true,shiftKey:true}),true);
  assert.equal(isAskForChangeShortcut({key:'i',ctrlKey:true}),true);
  for(const event of [{key:'x',ctrlKey:true},{key:'X',shiftKey:true},{key:'I',ctrlKey:true,shiftKey:true},{key:'X',ctrlKey:true,shiftKey:true,altKey:true},{key:'X',ctrlKey:true,shiftKey:true,isComposing:true},{key:'X',ctrlKey:true,shiftKey:true,repeat:true},{key:'X',ctrlKey:true,shiftKey:true,keyCode:229}])assert.equal(isAskForChangeShortcut(event),false);
});

test('selection bubble prefers above, editor stays below, with edge fallbacks',()=>{
  const bounds={left:0,top:40,right:700,bottom:600},anchor={left:100,top:200,bottom:220};
  assert.equal(placeSelectionPopup(anchor,{width:160,height:24},bounds,{preferAbove:true}).top,168);
  assert.equal(placeSelectionPopup(anchor,{width:294,height:44},bounds).top,228);
  assert.equal(placeSelectionPopup({left:100,top:44,bottom:60},{width:160,height:24},bounds,{preferAbove:true}).top,68);
  const edge=placeSelectionPopup({left:690,top:550,bottom:575},{width:294,height:44},bounds);
  assert.ok(edge.left+294<=692&&edge.top+44<=592);
});

test('inline shell has one selection action, the reference placeholder, and local same-field dictation',()=>{
  const shell=readFileSync(new URL('../src/shell.html',import.meta.url),'utf8');
  const toolbar=shell.split('id="selection-actions"')[1].split('</div>')[0];
  assert.equal((toolbar.match(/<button/g)||[]).length,1);
  assert.ok(toolbar.includes('Ctrl Shift X'));
  assert.match(shell,/rows="1"[^>]+placeholder="Describe a change or ask a question"/);
  assert.match(shell,/id="feedback-voice"[^>]+aria-label="Dictate in this input"/);
  assert.match(shell,/id="feedback-save"[^>]+hidden/);
  assert.ok(!shell.includes('id="collect-comment"'));
  assert.match(shell,/offline recognition to insert speech directly here/);
  assert.ok(!shell.includes('maxlength="2000"'),'Programmatically returned speech must never be silently truncated.');
  assert.match(shell,/id="feedback-dictation-status"[^>]+role="status"/);
  assert.match(shell,/id="feedback-dictation-cancel"[^>]+aria-label="Cancel dictation"[^>]+hidden/);
  assert.match(shell,/Recording starts only when you click the microphone/);
  assert.ok(!/On first use|permission window|click Start in/i.test(shell));
});
