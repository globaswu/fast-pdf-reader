import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initializeToolbar} from '../src/toolbar.mjs';

const shell=await readFile(new URL('../src/shell.html',import.meta.url),'utf8');
const toolbar=shell.match(/<header\b[^>]*\bid="toolbar"[^>]*>[\s\S]*?<\/header>/)?.[0];
assert.ok(toolbar,'The shell must contain the PDF toolbar.');

function attribute(tag,name){return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];}
function openingTag(id){
  const tag=[...shell.matchAll(/<[a-z][\w-]*\b[^>]*>/gi)].map(match=>match[0]).find(tag=>attribute(tag,'id')===id);
  assert.ok(tag,`Missing element #${id}`);
  return tag;
}

test('toolbar preserves each viewer control and dynamic target exactly once',()=>{
  const ids=[...shell.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,'Duplicate IDs make event bindings ambiguous.');
  const expected=['toolbar','outline-toggle','document-name','choose-file','local-file-input','previous','page-number','page-count','next','zoom-out','zoom','custom-zoom','zoom-in','find-toggle','reload','open-folder','open-default','region-toggle','feedback-toggle','feedback-count','file-menu'];
  const toolbarIds=[...toolbar.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);
  for(const id of expected)assert.equal(toolbarIds.filter(value=>value===id).length,1,`Expected one toolbar target #${id}`);
  assert.equal(attribute(openingTag('page-number'),'type'),'number');
  assert.equal(attribute(openingTag('page-number'),'min'),'1');
  assert.equal(attribute(openingTag('page-number'),'step'),'1');
  assert.equal(attribute(openingTag('local-file-input'),'type'),'file');
  assert.match(openingTag('local-file-input'),/\shidden(?:\s|>)/);
  assert.match(toolbar,/<label\b[^>]*\bfor="page-number"[^>]*>Physical PDF page<\/label>/);
  assert.match(toolbar,/<label\b[^>]*\bfor="zoom"[^>]*>Zoom<\/label>/);
  assert.equal(attribute(openingTag('outline-toggle'),'aria-controls'),'outline-panel');
  assert.equal(attribute(openingTag('feedback-toggle'),'aria-controls'),'feedback-panel');
  assert.equal(attribute(openingTag('region-toggle'),'aria-pressed'),'false');
  for(const id of ['outline-toggle','find-toggle','feedback-toggle'])assert.equal(attribute(openingTag(id),'aria-expanded'),'false');
  for(const id of ['previous','next','page-number','zoom-out','zoom','zoom-in','find-toggle','reload','region-toggle','open-folder','open-default'])assert.match(openingTag(id),/\sdisabled(?:\s|>)/,`#${id} must await document readiness.`);
});

test('zoom retains the supported values, default preset and dynamic option',()=>{
  const select=toolbar.match(/<select\b[^>]*\bid="zoom"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select);
  const options=[...select.matchAll(/<option\b[^>]*>/g)].map(match=>match[0]);
  assert.deepEqual(options.map(tag=>attribute(tag,'value')),['auto','page-width','page-fit','0.75','1','1.25','1.5','2','3','custom']);
  const selected=options.filter(tag=>/\sselected(?:\s|>)/.test(tag));
  assert.equal(selected.length,1);
  assert.equal(attribute(selected[0],'value'),'page-width');
  assert.equal(attribute(openingTag('custom-zoom'),'value'),'custom');
  assert.match(openingTag('custom-zoom'),/\shidden(?:\s|>)/);
});

test('icon controls have accessible names and decorative SVGs stay out of focus order',()=>{
  const controls=[...toolbar.matchAll(/<(button|summary)\b[^>]*class="[^"]*\bicon-button\b[^"]*"[^>]*>/g)].map(match=>match[0]);
  assert.equal(controls.length,10);
  for(const tag of controls){
    assert.ok(attribute(tag,'aria-label')?.trim(),`Missing accessible name: ${tag}`);
    assert.ok(attribute(tag,'title')?.trim(),`Missing tooltip: ${tag}`);
  }
  const icons=[...toolbar.matchAll(/<svg\b[^>]*>/g)].map(match=>match[0]);
  assert.ok(icons.length>=controls.length);
  for(const tag of icons){
    assert.equal(attribute(tag,'aria-hidden'),'true');
    assert.equal(attribute(tag,'focusable'),'false');
  }
  assert.match(toolbar,/<details\b[^>]*\bid="file-menu"/);
  assert.doesNotMatch(toolbar,/\srole="(?:menu|menuitem)"/,'Native disclosure actions retain normal button keyboard behavior.');
});

function fixture(){
  let focused=null;
  function node(tagName,parent=null){
    const listeners=new Map();
    return {
      tagName,parent,disabled:false,open:false,listeners,
      addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(listener);},
      removeEventListener(type,listener){listeners.get(type)?.delete(listener);},
      fire(type,properties={}){
        const event={target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...properties};
        for(const listener of listeners.get(type)||[])listener(event);
        return event;
      },
      contains(target){for(let current=target;current;current=current.parent)if(current===this)return true;return false;},
      closest(selector){for(let current=this;current;current=current.parent)if(current.tagName===selector)return current;return null;},
      focus(){focused=this;},
    };
  }
  const document=node('document'),menu=node('details',document),summary=node('summary',menu);
  const action=node('button',menu),icon=node('svg',action),outside=node('button',document);
  document.getElementById=id=>id==='file-menu'?menu:null;
  menu.querySelector=selector=>selector==='summary'?summary:null;
  const dispose=initializeToolbar(document);
  return {document,menu,summary,action,icon,outside,dispose,get focused(){return focused;}};
}

test('outside pointer dismisses More without taking focus; inside pointer leaves it open',()=>{
  const ui=fixture();
  ui.menu.open=true;
  ui.document.fire('pointerdown',{target:ui.icon});
  assert.equal(ui.menu.open,true);
  ui.outside.focus();
  ui.document.fire('pointerdown',{target:ui.outside});
  assert.equal(ui.menu.open,false);
  assert.equal(ui.focused,ui.outside);
  ui.dispose();
});

test('Escape closes More and returns focus to its summary',()=>{
  const ui=fixture();
  ui.menu.open=true;ui.action.focus();
  const event=ui.document.fire('keydown',{key:'Escape',target:ui.action});
  assert.equal(ui.menu.open,false);
  assert.equal(ui.focused,ui.summary);
  assert.equal(event.defaultPrevented,true);
  ui.dispose();
});

test('closed More does not intercept Escape, and other keys leave open More alone',()=>{
  const ui=fixture();
  ui.outside.focus();
  const escape=ui.document.fire('keydown',{key:'Escape',target:ui.outside});
  assert.equal(escape.defaultPrevented,false);
  assert.equal(ui.focused,ui.outside);
  ui.menu.open=true;
  const tab=ui.document.fire('keydown',{key:'Tab',target:ui.summary});
  assert.equal(ui.menu.open,true);
  assert.equal(tab.defaultPrevented,false);
  ui.dispose();
});

test('enabled action dismisses More when its nested icon is clicked',()=>{
  const ui=fixture();
  ui.menu.open=true;
  const event=ui.menu.fire('click',{target:ui.icon});
  assert.equal(ui.menu.open,false);
  assert.equal(event.defaultPrevented,false,'The action must retain its normal click behavior.');
  ui.dispose();
});

test('disabled actions and the native summary do not trigger action dismissal',()=>{
  const ui=fixture();
  ui.menu.open=true;ui.action.disabled=true;
  ui.menu.fire('click',{target:ui.icon});
  assert.equal(ui.menu.open,true);
  const event=ui.menu.fire('click',{target:ui.summary});
  assert.equal(ui.menu.open,true);
  assert.equal(event.defaultPrevented,false,'The summary retains native disclosure toggling.');
  ui.dispose();
});

test('disposal removes all listeners and leaves later input untouched',()=>{
  const ui=fixture();
  ui.dispose();ui.dispose();
  for(const target of [ui.document,ui.menu])for(const listeners of target.listeners.values())assert.equal(listeners.size,0);
  ui.menu.open=true;ui.outside.focus();
  ui.document.fire('pointerdown',{target:ui.outside});
  const event=ui.document.fire('keydown',{key:'Escape',target:ui.outside});
  ui.menu.fire('click',{target:ui.icon});
  assert.equal(ui.menu.open,true);
  assert.equal(ui.focused,ui.outside);
  assert.equal(event.defaultPrevented,false);
});
