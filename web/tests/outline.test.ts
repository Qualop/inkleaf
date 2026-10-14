import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { OutlineNavigator } from '../client/outline.ts';

const source='# Alpha\ntext\n## Beta\n### Gamma\n## Beta\n# Delta\n';
function fixture(text=source){
  const dom=new JSDOM('<div class="outline"></div>'),container=dom.window.document.querySelector<HTMLElement>('.outline')!,selected:any[]=[];
  const navigator=new OutlineNavigator(container,entry=>selected.push(entry));navigator.update(text,{from:0,to:0});
  const query=<T extends Element=HTMLElement>(selector:string)=>container.querySelector<T>(selector)!;
  const rows=()=>[...container.querySelectorAll<HTMLElement>('[data-outline-row]')];
  const ids=()=>rows().map(row=>row.dataset.outlineId);
  const filter=(value:string)=>{const input=query<HTMLInputElement>('[data-outline-filter]');input.value=value;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
  const depth=(value:string)=>{const select=query<HTMLSelectElement>('[data-outline-depth]');select.value=value;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
  const cleanup=()=>{navigator.destroy();dom.window.close();};
  return {dom,container,navigator,selected,query,rows,ids,filter,depth,cleanup};
}
test('outline renders literal IDs and selects exact original source offsets',()=>{
  const f=fixture();try{
    assert.deepEqual(f.ids(),['alpha','beta','gamma','beta-1','delta']);
    f.query<HTMLButtonElement>('[data-outline-id="beta"] [data-outline-select]').click();
    assert.deepEqual(f.selected,[{level:2,title:'Beta',line:3,from:13,to:20,id:'beta'}]);
    assert.equal(f.query('[data-outline-filter]').getAttribute('aria-label'),'Filter headings');assert.equal(f.query('[data-outline-depth]').getAttribute('aria-label'),'Maximum heading level');
    assert.equal(f.query('[data-outline-id="gamma"] [data-outline-select]').getAttribute('aria-label'),'Gamma, heading level 3, line 4');
  }finally{f.cleanup();}
});
test('selection-only updates retain heading nodes and focus without rebuilding the list',()=>{
  const f=fixture();try{
    const original=f.rows(),filter=f.query<HTMLInputElement>('[data-outline-filter]'),list=f.query('[data-outline-list]');filter.focus();
    const observer=new f.dom.window.MutationObserver(()=>{});observer.observe(list,{subtree:true,childList:true});
    f.navigator.update(source,{from:25,to:29});
    assert.deepEqual(f.rows(),original);assert.equal(f.dom.window.document.activeElement,filter);assert.equal(observer.takeRecords().length,0);
    assert.equal(f.query('[aria-current="location"]').closest('[data-outline-row]')!.getAttribute('data-outline-id'),'gamma');
    assert.equal(f.query<HTMLElement>('[data-outline-id="gamma"] [data-outline-current-marker]').hidden,false);
    f.navigator.update(source,{from:45,to:45});assert.equal(f.query('[aria-current="location"]').closest('[data-outline-row]')!.getAttribute('data-outline-id'),'delta');
    assert.equal(f.query<HTMLElement>('[data-outline-id="gamma"] [data-outline-current-marker]').hidden,true);observer.disconnect();
  }finally{f.cleanup();}
});
test('depth and collapse controls operate on real heading hierarchy',()=>{
  const f=fixture();try{
    f.depth('2');assert.deepEqual(f.ids(),['alpha','beta','beta-1','delta']);f.depth('6');
    f.query<HTMLButtonElement>('[data-outline-id="beta"] [data-outline-disclosure]').click();assert.deepEqual(f.ids(),['alpha','beta','beta-1','delta']);
    assert.equal(f.query('[data-outline-id="beta"] [data-outline-disclosure]').getAttribute('aria-expanded'),'false');
    f.query<HTMLButtonElement>('[data-outline-expand-all]').click();assert.deepEqual(f.ids(),['alpha','beta','gamma','beta-1','delta']);
    f.query<HTMLButtonElement>('[data-outline-collapse-all]').click();assert.deepEqual(f.ids(),['alpha','delta']);assert.match(f.query('[data-outline-count]').textContent!,/2 of 2.*5 total/);
  }finally{f.cleanup();}
});
test('filter searches all levels and reveals ancestor context without erasing normal collapse state',()=>{
  const f=fixture();try{
    f.query<HTMLButtonElement>('[data-outline-id="alpha"] [data-outline-disclosure]').click();f.depth('1');f.filter('gAmMa');
    assert.deepEqual(f.ids(),['alpha','beta','gamma']);assert.equal(f.query('[data-outline-id="beta"]').getAttribute('data-outline-context'),'true');
    assert.equal(f.query('[data-outline-id="gamma"]').getAttribute('data-outline-match'),'true');assert.match(f.query('[data-outline-count]').textContent!,/1 match/);
    f.query<HTMLButtonElement>('[data-outline-id="beta"] [data-outline-disclosure]').click();assert.deepEqual(f.ids(),['alpha','beta']);
    assert.equal(f.query('[data-outline-id="beta"] [data-outline-disclosure]').getAttribute('aria-expanded'),'false');assert.match(f.query('[data-outline-count]').textContent!,/1 match/);
    f.query<HTMLButtonElement>('[data-outline-clear-filter]').click();assert.deepEqual(f.ids(),['alpha','delta']);assert.equal(f.query('[data-outline-id="alpha"] [data-outline-disclosure]').getAttribute('aria-expanded'),'false');
    f.depth('6');f.query<HTMLButtonElement>('[data-outline-id="alpha"] [data-outline-disclosure]').click();assert.deepEqual(f.ids(),['alpha','beta','gamma','beta-1','delta']);
  }finally{f.cleanup();}
});
test('hidden current heading remains indicated without falsely marking its ancestor current',()=>{
  const f=fixture();try{
    f.query<HTMLButtonElement>('[data-outline-id="beta"] [data-outline-disclosure]').click();f.navigator.update(source,{from:25,to:25});
    assert.equal(f.container.querySelector('[aria-current]'),null);assert.match(f.query('[data-outline-current]').textContent!,/Gamma.*not shown/);
    assert.equal(f.query('[data-outline-id="beta"]').getAttribute('data-outline-contains-current'),'true');
  }finally{f.cleanup();}
});
test('initial rendering caps at 500 rows and Show More actually reveals remaining headings',()=>{
  const text=Array.from({length:700},(_,index)=>`# H${String(index).padStart(4,'0')}\n`).join(''),f=fixture(text);try{
    assert.equal(f.rows().length,500);assert.match(f.query('[data-outline-count]').textContent!,/500 of 700/);
    const more=f.query<HTMLButtonElement>('[data-outline-show-more]');assert.equal(more.textContent,'Show 200 more headings');more.click();
    assert.equal(f.rows().length,700);assert.equal(more.hidden,true);assert.match(f.query('[data-outline-count]').textContent!,/700 of 700/);
  }finally{f.cleanup();}
});
test('filter finds a literal heading beyond the initial 500-row window and selects its exact offset',()=>{
  const text=Array.from({length:700},(_,index)=>`# H${String(index).padStart(4,'0')}\n`).join(''),f=fixture(text);try{
    f.filter('H0555');assert.deepEqual(f.ids(),['h0555']);f.query<HTMLButtonElement>('[data-outline-id="h0555"] [data-outline-select]').click();
    assert.deepEqual(f.selected,[{level:1,title:'H0555',line:556,from:4440,to:4447,id:'h0555'}]);
    assert.match(f.query('[data-outline-count]').textContent!,/1 match/);
  }finally{f.cleanup();}
});
test('empty, unmatched and fenced-code headings have safe distinct states',()=>{
  const f=fixture('plain text\n```md\n# hidden\n```');try{
    assert.equal(f.rows().length,0);assert.match(f.query('[data-outline-empty]').textContent!,/No headings/);assert.equal(f.query<HTMLButtonElement>('[data-outline-show-more]').hidden,true);
    f.navigator.update('# Outside\n```md\n# hidden\n```',{from:0,to:0});assert.deepEqual(f.ids(),['outside']);f.filter('not present');assert.equal(f.rows().length,0);assert.match(f.query('[data-outline-empty]').textContent!,/No matching headings/);
    f.navigator.update('',{from:0,to:0});assert.equal(f.container.querySelector('[aria-current]'),null);
  }finally{f.cleanup();}
});
test('source changes rebuild headings but source markup never becomes live HTML',()=>{
  const f=fixture();try{
    f.navigator.update('# <img src=x onerror="bad()"> Safe\n## Child',{from:0,to:0});assert.equal(f.container.querySelector('img'),null);assert.equal(f.container.querySelector('script'),null);
    assert.deepEqual(f.ids(),['img-srcx-onerrorbad-safe','child']);assert.equal(f.query('[data-outline-id="img-srcx-onerrorbad-safe"] [data-outline-title]').textContent,'<img src=x onerror="bad()"> Safe');
    f.navigator.destroy();f.navigator.update(source,{from:0,to:0});assert.equal(f.container.childElementCount,0);
  }finally{f.cleanup();}
});
