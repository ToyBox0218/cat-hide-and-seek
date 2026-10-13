(function(root,factory){
  const api=factory(root?.CatBoardStrokes);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.CatBoardPointerAdapter=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(DefaultStrokes){
  'use strict';

  const finite=value=>Number.isFinite(value);
  const defaultNow=()=>typeof performance==='object'&&typeof performance.now==='function'?performance.now():Date.now();

  function create(options={}){
    const doc=options.document||globalThis.document,win=options.window||globalThis.window,Strokes=options.Strokes||DefaultStrokes;
    if(!doc||!win||!Strokes?.create)throw new TypeError('board pointer adapter requires document, window and CatBoardStrokes');
    for(const name of ['getGrid','getContext','canAct','canMark','onAdd'])if(typeof options[name]!=='function')throw new TypeError(`${name} must be a function`);
    const records=new Map(),pointerProperty=options.pointerProperty||'boardPointerState',selector=options.cellSelector||'.cell',now=options.now||defaultNow;
    let geometry=null,capture=null,clickSuppressedUntil=0,disposed=false;

    function currentGeometry(){
      const grid=options.getGrid();if(!grid)return null;
      const bounds=grid.getBoundingClientRect(),key=options.getContext(),old=geometry;
      if(old&&old.grid===grid&&old.key===key&&['left','top','width','height'].every(name=>old.bounds[name]===bounds[name]))return old;
      return geometry={grid,key,bounds,cells:Array.from(grid.children).map(cell=>({index:+cell.dataset.index,rect:cell.getBoundingClientRect()}))};
    }
    function cellAt(x,y){
      const value=currentGeometry();if(!value)return null;
      const hit=doc.elementFromPoint?.(x,y)?.closest?.(selector);
      if(hit&&value.grid.contains?.(hit)&&(!options.isCellCurrent||options.isCellCurrent(hit)))return +hit.dataset.index;
      if(doc.elementFromPoint)return null;
      return value.cells.find(({rect})=>x>=rect.left&&x<rect.left+rect.width&&y>=rect.top&&y<rect.top+rect.height)?.index??null;
    }
    function indicesBetween(from,to,context){
      if(context!==options.getContext())return [];
      const value=currentGeometry();if(!value)return [];
      const dx=to.x-from.x,dy=to.y-from.y,hits=[];
      for(const {index,rect} of value.cells){
        const inset=Math.min(.5,rect.width/8,rect.height/8),left=rect.left+inset,right=rect.left+rect.width-inset,top=rect.top+inset,bottom=rect.top+rect.height-inset;
        let enter=0,leave=1,valid=true;
        for(const [start,delta,min,max] of [[from.x,dx,left,right],[from.y,dy,top,bottom]]){
          if(delta===0){if(start<min||start>max){valid=false;break;}continue;}
          const a=(min-start)/delta,b=(max-start)/delta;enter=Math.max(enter,Math.min(a,b));leave=Math.min(leave,Math.max(a,b));if(enter>leave){valid=false;break;}
        }
        if(valid)hits.push({index,enter});
      }
      return hits.sort((a,b)=>a.enter-b.enter).map(hit=>hit.index);
    }
    function values(event){return{pointerId:event.pointerId,pointerType:event.pointerType,button:event.button,buttons:event.buttons,isPrimary:event.isPrimary,clientX:event.clientX,clientY:event.clientY,timeStamp:event.timeStamp};}
    function strokeEvent(event,record){
      const x=finite(event.clientX)?event.clientX:record?.x,y=finite(event.clientY)?event.clientY:record?.y;
      let at=now(),stamp=event.timeStamp;
      if(record&&finite(stamp)&&finite(record.stamp)&&stamp>=record.stamp&&(stamp>=1e12)===(record.stamp>=1e12))at=record.began+(stamp-record.stamp);
      return{id:event.pointerId??record?.id??1,type:event.pointerType||record?.type||'mouse',button:event.button??0,buttons:event.buttons,primary:event.isPrimary!==false,x,y,index:cellAt(x,y),now:at};
    }
    function releaseCapture(){
      const held=capture;capture=null;
      if(held)try{if(held.cell.hasPointerCapture?.(held.id))held.cell.releasePointerCapture(held.id);}catch{}
    }
    const strokes=Strokes.create({cellCount:options.cellCount,getContext:options.getContext,canAct:options.canAct,canMark:options.canMark,onAdd:options.onAdd,indicesBetween,now,
      onStart:event=>{
        options.onCancelGestures?.('stroke-start');
        const record=records.get(event.id);if(record){record.consumed=true;options.onCancelPress?.(record.cell);}
        options.getGrid()?.classList.add(options.activeClass||'marking-stroke');
        if(record?.cell)try{record.cell.setPointerCapture?.(event.id);capture={cell:record.cell,id:event.id};}catch{}
        options.onStrokeStart?.(event,record,strokes);
      },
      onEnd:event=>{
        const record=records.get(event.id);if(record)record.consumed=event.consumed;
        if(event.consumed){options.onCancelGestures?.('stroke-end');clickSuppressedUntil=Date.now()+(options.clickSuppressMs||600);if(record?.cell)options.onCancelPress?.(record.cell);}
        options.getGrid()?.classList.remove(options.activeClass||'marking-stroke');releaseCapture();options.onStrokeEnd?.(event,record);
      }});
    function start(cell,event){
      if(event.button>0)return null;
      const rect=cell.getBoundingClientRect(),id=event.pointerId??1,record={id,type:event.pointerType||'mouse',cell,consumed:false,x:finite(event.clientX)?event.clientX:rect.left+rect.width/2,y:finite(event.clientY)?event.clientY:rect.top+rect.height/2,began:now(),stamp:event.timeStamp};
      records.set(id,record);cell[pointerProperty]=record;
      const outcome=strokes.down({...strokeEvent(event,record),index:+cell.dataset.index});
      if(outcome.consumed){record.consumed=true;options.onCancelPress?.(cell);options.onCancelGestures?.('stroke-consumed');}
      return record;
    }
    function move(event){
      const id=event.pointerId??1;if(!records.has(id))return;
      const record=records.get(id),samples=event.getCoalescedEvents?.()||[];
      if(record.type!=='touch'&&event.buttons!==undefined&&!(event.buttons&1)){cancelPointer(event,'released');return;}
      for(const sample of [...samples,event]){const outcome=strokes.move(strokeEvent({...values(sample),pointerId:event.pointerId,pointerType:event.pointerType},record));if(outcome.consumed){record.consumed=true;options.onCancelGestures?.('stroke-consumed');if(record.cell)options.onCancelPress?.(record.cell);}}
      if(strokes.state().active&&event.cancelable)event.preventDefault();
    }
    function finish(event,cell=null){
      const id=event.pointerId??cell?.[pointerProperty]?.id??1,current=records.get(id);
      if(cell&&current&&current!==cell[pointerProperty])return cell[pointerProperty]||null;
      const record=current||cell?.[pointerProperty];if(!record)return null;
      const outcome=strokes.up(strokeEvent({...values(event),pointerId:id},record));record.consumed=record.consumed||outcome.consumed;records.delete(id);return record;
    }
    function cancelPointer(event,reason='pointercancel'){
      const id=event.pointerId??1,record=records.get(id);strokes.pointerCancel({id},reason);
      if(record){record.consumed=true;if(record.cell)options.onCancelPress?.(record.cell);}records.delete(id);return record||null;
    }
    function observeExtra(event){
      const wiredTarget=event.target?.closest?.(selector);if(event.button>0||!strokes.state().pointerCount||records.has(event.pointerId??1)||wiredTarget?.[pointerProperty])return;
      const id=event.pointerId??1,record={id,type:event.pointerType||'mouse',cell:null,consumed:true,x:event.clientX,y:event.clientY,began:now(),stamp:event.timeStamp};records.set(id,record);strokes.down({...strokeEvent(event,record),index:null});options.onCancelGestures?.('extra-pointer');
    }
    function reset(reason='reset'){
      strokes.reset(reason);for(const record of records.values()){record.consumed=true;if(record.cell)options.onCancelPress?.(record.cell);}records.clear();geometry=null;releaseCapture();options.getGrid()?.classList.remove(options.activeClass||'marking-stroke');options.onReset?.(reason);
    }
    function cancel(reason='cancel'){strokes.cancel(reason);}
    function wireCell(cell,index,hooks={}){
      cell.onpointerdown=event=>{if(event.button>0)return;hooks.onPointerDown?.(cell,event,index);start(cell,event);};
      cell.onpointercancel=event=>{hooks.onCancel?.(cell,event,'pointercancel');cancelPointer(event);};
      cell.onlostpointercapture=event=>{if(capture?.cell===cell){hooks.onCancel?.(cell,event,'lostcapture');cancelPointer(event,'lostcapture');}};
      cell.onblur=()=>{hooks.onCancel?.(cell,null,'cell-blur');const pointer=cell[pointerProperty];if(pointer&&records.get(pointer.id)===pointer)cancelPointer({pointerId:pointer.id},'cell-blur');};
      cell.onclick=event=>{if(event.button>0)return;const pointer=cell[pointerProperty];if(pointer)finish({...values(event),pointerId:pointer.id,pointerType:pointer.type},cell);cell[pointerProperty]=null;hooks.onClick?.(cell,event,{pointer,consumed:Boolean(pointer?.consumed),suppressed:!pointer&&Date.now()<clickSuppressedUntil});};
      cell.onkeydown=event=>hooks.onKeydown?.(cell,event,index);
    }
    const listeners=[[doc,'pointerdown',observeExtra],[doc,'pointermove',move,{passive:false}],[doc,'pointerup',finish],[doc,'pointercancel',cancelPointer],[doc,'scroll',()=>{if(strokes.state().tracking)cancel('scroll');},true],[win,'resize',()=>{if(strokes.state().tracking)cancel('resize');else geometry=null;}]];
    for(const [target,type,listener,settings] of listeners)target.addEventListener(type,listener,settings);
    function dispose(){if(disposed)return;disposed=true;reset('dispose');for(const [target,type,listener,settings] of listeners)target.removeEventListener(type,listener,settings);}
    return{wireCell,start,move,finish,cancelPointer,reset,cancel,dispose,invalidateGeometry(){geometry=null;},state:()=>({records:records.size,capture:Boolean(capture),clickSuppressedUntil,stroke:strokes.state()}),strokes};
  }
  return{create};
});
