import { getOutline } from '../core/statistics.ts';
import type { OutlineEntry } from '../core/statistics.ts';

type Selection = { from:number; to:number };
type Row = { element:HTMLLIElement; select:HTMLButtonElement; marker:HTMLSpanElement };
const PAGE_SIZE = 500;

/** Owns the outline container. Source changes parse once; cursor changes only update indicators. */
export class OutlineNavigator {
  private container:HTMLElement;
  private onSelect:(entry:OutlineEntry)=>void;
  private source:string|undefined;
  private headings:OutlineEntry[]=[];
  private parents:number[]=[];
  private children=new Set<number>();
  private collapsed=new Set<string>();
  private filteredCollapsed=new Set<string>();
  private filter:HTMLInputElement;
  private depth:HTMLSelectElement;
  private list:HTMLOListElement;
  private count:HTMLParagraphElement;
  private current:HTMLParagraphElement;
  private empty:HTMLParagraphElement;
  private more:HTMLButtonElement;
  private expand:HTMLButtonElement;
  private collapse:HTMLButtonElement;
  private rows=new Map<number,Row>();
  private selection:Selection={from:0,to:0};
  private currentIndex=-1;
  private limit=PAGE_SIZE;
  private destroyed=false;

  constructor(container:HTMLElement,onSelect:(entry:OutlineEntry)=>void) {
    this.container=container;this.onSelect=onSelect;
    const doc=container.ownerDocument,controls=doc.createElement('div');controls.className='outline-controls';controls.setAttribute('role','group');controls.setAttribute('aria-label','Outline controls');
    const button=(caption:string,data:string)=>{const control=doc.createElement('button');control.type='button';control.textContent=caption;control.setAttribute(data,'');return control;};
    this.filter=doc.createElement('input');this.filter.type='search';this.filter.placeholder='Search all headings';this.filter.setAttribute('aria-label','Filter headings');this.filter.setAttribute('data-outline-filter','');
    const filterLabel=doc.createElement('label');filterLabel.append('Filter headings',this.filter);
    this.depth=doc.createElement('select');this.depth.setAttribute('aria-label','Maximum heading level');this.depth.setAttribute('data-outline-depth','');
    for(let level=1;level<=6;level++){const option=doc.createElement('option');option.value=String(level);option.textContent=level===6?'All levels':`Through heading level ${level}`;this.depth.append(option);}this.depth.value='6';
    const depthLabel=doc.createElement('label');depthLabel.append('Maximum heading level',this.depth);
    const clear=button('Clear Filter','data-outline-clear-filter');this.expand=button('Expand All','data-outline-expand-all');this.collapse=button('Collapse All','data-outline-collapse-all');
    controls.append(filterLabel,depthLabel,clear,this.expand,this.collapse);
    this.count=doc.createElement('p');this.count.setAttribute('data-outline-count','');this.count.setAttribute('role','status');this.count.setAttribute('aria-live','polite');
    this.current=doc.createElement('p');this.current.setAttribute('data-outline-current','');
    const nav=doc.createElement('nav');nav.setAttribute('aria-label','Outline headings');
    this.list=doc.createElement('ol');this.list.setAttribute('data-outline-list','');this.list.style.listStyle='none';this.list.style.padding='0';nav.append(this.list);
    this.empty=doc.createElement('p');this.empty.setAttribute('data-outline-empty','');
    this.more=button('Show More','data-outline-show-more');this.more.hidden=true;
    container.replaceChildren(controls,this.count,this.current,nav,this.empty,this.more);
    this.filter.addEventListener('input',()=>{this.filteredCollapsed.clear();this.limit=PAGE_SIZE;this.render();});
    clear.addEventListener('click',()=>{this.filter.value='';this.filteredCollapsed.clear();this.limit=PAGE_SIZE;this.render();this.filter.focus();});
    this.depth.addEventListener('change',()=>{this.limit=PAGE_SIZE;this.render();});
    this.expand.addEventListener('click',()=>{this.collapseState().clear();this.limit=PAGE_SIZE;this.render();});
    this.collapse.addEventListener('click',()=>{const state=this.collapseState();for(const index of this.children)state.add(this.headings[index].id);this.limit=PAGE_SIZE;this.render();});
    this.more.addEventListener('click',()=>{this.limit+=PAGE_SIZE;this.render();});
    this.render();
  }

  update(source:string,selection:Selection):void {
    if(this.destroyed)return;
    this.selection={...selection};
    if(source===this.source){this.indicateCurrent();return;}
    this.source=source;this.headings=getOutline(source);this.parents=[];this.children.clear();
    const stack:number[]=[];
    for(let index=0;index<this.headings.length;index++){
      while(stack.length && this.headings[stack.at(-1)!].level>=this.headings[index].level)stack.pop();
      const parent=stack.at(-1) ?? -1;this.parents.push(parent);if(parent>=0)this.children.add(parent);stack.push(index);
    }
    const ids=new Set(this.headings.map(heading=>heading.id));
    for(const state of [this.collapsed,this.filteredCollapsed])for(const id of state)if(!ids.has(id))state.delete(id);
    this.limit=PAGE_SIZE;this.render();
  }

  private query():string {return this.filter.value.trim().normalize('NFC').toLocaleLowerCase();}
  private collapseState():Set<string> {return this.query()?this.filteredCollapsed:this.collapsed;}

  private render():void {
    if(this.destroyed)return;
    const query=this.query(),matches=new Set<number>(),included=new Set<number>();
    for(let index=0;index<this.headings.length;index++){
      if(query){
        if(!this.headings[index].title.normalize('NFC').toLocaleLowerCase().includes(query))continue;
        matches.add(index);for(let ancestor=index;ancestor>=0;ancestor=this.parents[ancestor])included.add(ancestor);
      }else if(this.headings[index].level<=Number(this.depth.value))included.add(index);
    }
    const state=this.collapseState(),visible:number[]=[],disclosures=new Set<number>();
    for(const index of included)if(this.parents[index]>=0 && included.has(this.parents[index]))disclosures.add(this.parents[index]);
    for(let index=0;index<this.headings.length;index++){
      if(!included.has(index))continue;let hidden=false;
      for(let ancestor=this.parents[index];ancestor>=0;ancestor=this.parents[ancestor])if(state.has(this.headings[ancestor].id)){hidden=true;break;}
      if(!hidden)visible.push(index);
    }
    const shown=visible.slice(0,this.limit),doc=this.container.ownerDocument,fragment=doc.createDocumentFragment();this.rows.clear();
    for(const index of shown){
      const heading=this.headings[index],row=doc.createElement('li');row.setAttribute('data-outline-row','');row.dataset.outlineId=heading.id;row.dataset.outlineLevel=String(heading.level);
      row.dataset.outlineMatch=String(matches.has(index));row.dataset.outlineContext=String(!!query && !matches.has(index));
      row.style.setProperty('--level',String(heading.level));row.style.display='grid';row.style.gridTemplateColumns='1.5rem minmax(0, 1fr)';
      if((query?disclosures:this.children).has(index)){
        const disclosure=doc.createElement('button');disclosure.type='button';disclosure.setAttribute('data-outline-disclosure','');const expanded=!state.has(heading.id);
        disclosure.disabled=!query && !disclosures.has(index);disclosure.textContent=expanded?'▾':'▸';disclosure.setAttribute('aria-expanded',String(expanded));disclosure.setAttribute('aria-label',`${expanded?'Collapse':'Expand'} ${heading.title || 'Untitled heading'}, line ${heading.line}`);disclosure.style.padding='0';
        disclosure.addEventListener('click',()=>{if(state.has(heading.id))state.delete(heading.id);else state.add(heading.id);this.limit=PAGE_SIZE;this.render();});row.append(disclosure);
      }else{const spacer=doc.createElement('span');spacer.setAttribute('aria-hidden','true');row.append(spacer);}
      const select=doc.createElement('button');select.type='button';select.setAttribute('data-outline-select','');select.setAttribute('aria-label',`${heading.title || 'Untitled heading'}, heading level ${heading.level}, line ${heading.line}`);select.dataset.outlineFrom=String(heading.from);
      const title=doc.createElement('span');title.setAttribute('data-outline-title','');title.textContent=heading.title || 'Untitled heading';
      const marker=doc.createElement('span');marker.setAttribute('data-outline-current-marker','');marker.textContent=' · Current';marker.hidden=true;
      select.append(title,marker);select.addEventListener('click',()=>{if(!this.destroyed)this.onSelect({...heading});});row.append(select);fragment.append(row);this.rows.set(index,{element:row,select,marker});
    }
    this.list.replaceChildren(fragment);
    this.count.textContent=query?`${matches.size} ${matches.size===1?'match':'matches'}; showing ${shown.length} of ${visible.length} headings with ancestor context (${this.headings.length} total). Search includes all depths.`:`Showing ${shown.length} of ${visible.length} headings (${this.headings.length} total).`;
    this.empty.hidden=shown.length>0;this.empty.textContent=!this.headings.length?'No headings yet. Add a Markdown heading to navigate this document.':query?'No matching headings. Clear the filter to see the outline.':'No headings at this depth. Choose a deeper heading level.';
    this.more.hidden=shown.length>=visible.length;this.more.textContent=`Show ${Math.min(PAGE_SIZE,visible.length-shown.length)} more headings`;
    this.expand.disabled=this.collapse.disabled=!this.headings.length || !this.children.size;
    this.indicateCurrent(true);
  }

  private indicateCurrent(force=false):void {
    let low=0,high=this.headings.length-1,index=-1;
    const position=Number.isFinite(this.selection.from)?Math.max(0,this.selection.from):0;
    while(low<=high){const middle=(low+high)>>>1;if(this.headings[middle].from<=position){index=middle;low=middle+1;}else high=middle-1;}
    if(!force && index===this.currentIndex)return;this.currentIndex=index;
    const ancestors=new Set<number>();for(let parent=index>=0?this.parents[index]:-1;parent>=0;parent=this.parents[parent])ancestors.add(parent);
    for(const [rowIndex,row] of this.rows){
      const active=rowIndex===index;row.marker.hidden=!active;row.element.dataset.outlineCurrent=String(active);row.element.dataset.outlineContainsCurrent=String(ancestors.has(rowIndex));row.element.classList.toggle('is-current',active);
      if(active)row.select.setAttribute('aria-current','location');else row.select.removeAttribute('aria-current');
    }
    this.current.textContent=index<0?'No current heading.':`Current heading: ${this.headings[index].title || 'Untitled heading'}${this.rows.has(index)?'':' (not shown in the current outline)'}.`;
  }

  destroy():void {if(this.destroyed)return;this.destroyed=true;this.rows.clear();this.headings=[];this.container.replaceChildren();}
}
