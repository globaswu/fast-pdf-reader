// Native disclosure, ordinary buttons: no replacement menu keyboard system.
export function initializeToolbar(document) {
  const menu=document.getElementById('file-menu');
  const summary=menu.querySelector('summary');
  const onOutside=event=>{if(menu.open&&!menu.contains(event.target))menu.open=false;};
  const onAction=event=>{const button=event.target.closest('button');if(button&&!button.disabled)menu.open=false;};
  const onKey=event=>{if(event.key==='Escape'&&menu.open){menu.open=false;summary.focus();event.preventDefault();}};
  document.addEventListener('pointerdown',onOutside);
  document.addEventListener('keydown',onKey);
  menu.addEventListener('click',onAction);
  return()=>{document.removeEventListener('pointerdown',onOutside);document.removeEventListener('keydown',onKey);menu.removeEventListener('click',onAction);};
}
