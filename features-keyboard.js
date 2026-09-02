/* Rel.AI Companion — command palette keyboard navigation */
(() => {
  'use strict';
  function visiblePalette(){const p=document.getElementById('relai-command-palette');return p&&!p.hidden?p:null}
  function rows(p){return [...p.querySelectorAll('.relai-palette-row')].filter(el=>el.tagName==='BUTTON')}
  document.addEventListener('keydown',event=>{
    const p=visiblePalette();if(!p)return;
    const list=rows(p);if(!list.length)return;
    if(event.key!=='ArrowDown'&&event.key!=='ArrowUp'&&event.key!=='Enter')return;
    const active=document.activeElement,index=list.indexOf(active);
    if(event.key==='Enter'){
      if(index>=0){event.preventDefault();list[index].click()}
      return;
    }
    event.preventDefault();
    const next=event.key==='ArrowDown'?(index<0?0:(index+1)%list.length):(index<0?list.length-1:(index-1+list.length)%list.length);
    list[next].focus();
    list[next].scrollIntoView({block:'nearest'});
  },true);
})();
