(function(root,factory){
  const api=factory(root?.CatClassic);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.CatClassicProgress=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(DefaultClassic){
  'use strict';
  const SCHEMA=3,DEFAULT_PACK_ID='classic-original-300-v1',LEGACY_KEY='catClassicProgressV1',PREFIX='catClassicProgressV3:';
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  const unique=(values,predicate)=>Array.isArray(values)?[...new Set(values.filter(predicate))]:[];
  function create(options={}){
    const storage=options.storage||globalThis.localStorage,levels=options.levels||[],Classic=options.Classic||DefaultClassic;
    const packId=String(options.packId||DEFAULT_PACK_ID),key=`${options.prefix||PREFIX}${packId}`,legacyKey=options.legacyKey||LEGACY_KEY;
    if(!storage||!Classic?.fingerprint)throw new TypeError('classic progress requires storage and CatClassic.fingerprint');
    const ids=new Map(levels.map((level,index)=>[String(level.id||`classic-${index+1}`),index]));
    const idAt=index=>String(levels[index]?.id||`classic-${index+1}`),indexOf=id=>ids.has(String(id))?ids.get(String(id)):-1;
    const parse=name=>{try{return object(JSON.parse(storage.getItem(name)||'{}'))}catch{return{}}};
    const blank=()=>({schema:SCHEMA,packId,currentId:idAt(0),completed:[],boards:{},legacySource:null});
    function cleanBoard(record,level){
      const value=object(record),limit=level.size*level.size,fingerprint=Classic.fingerprint(level),givens=new Set(level.givens||[]);
      if(value.fingerprint!==fingerprint)return{fingerprint,cats:[],crosses:[],matched:false};
      const cats=unique(value.cats,index=>Number.isInteger(index)&&index>=0&&index<limit&&!givens.has(index));
      const occupied=new Set([...givens,...cats]),crosses=unique(value.crosses,index=>Number.isInteger(index)&&index>=0&&index<limit&&!occupied.has(index));
      return{fingerprint,cats,crosses,matched:true};
    }
    function normalize(raw){
      const value=object(raw),progress=blank();progress.legacySource=typeof value.legacySource==='string'?value.legacySource:null;
      progress.currentId=indexOf(value.currentId)>=0?String(value.currentId):idAt(0);
      progress.completed=unique(value.completed,id=>indexOf(id)>=0).map(String);
      const source=object(value.boards);for(let index=0;index<levels.length;index++){const id=idAt(index),record=cleanBoard(source[id],levels[index]);if(record.matched)progress.boards[id]=record;}
      return progress;
    }
    function importLegacy(){
      if(packId!==DEFAULT_PACK_ID)return blank();const legacy=parse(legacyKey),progress=blank(),boards=object(legacy.boards);
      progress.legacySource=legacyKey;const current=Number.isInteger(legacy.current)?Math.max(0,Math.min(levels.length-1,legacy.current)):0;progress.currentId=idAt(current);
      progress.completed=unique(legacy.completed,index=>Number.isInteger(index)&&index>=0&&index<levels.length).map(idAt);
      for(let index=0;index<levels.length;index++){const record=object(boards[index]);if(!Array.isArray(record.cats)&&!Array.isArray(record.crosses))continue;progress.boards[idAt(index)]={fingerprint:Classic.fingerprint(levels[index]),cats:record.cats||[],crosses:record.crosses||[]};}
      return normalize(progress);
    }
    function read(){const raw=parse(key);return raw.schema===SCHEMA&&raw.packId===packId?normalize(raw):importLegacy();}
    function write(progress){const value=normalize({...progress,schema:SCHEMA,packId});storage.setItem(key,JSON.stringify(value));return value;}
    function clear(){const value=blank();value.legacySource=storage.getItem(legacyKey)==null?null:legacyKey;return write(value);}
    function board(progress,index){return cleanBoard(object(progress?.boards)[idAt(index)],levels[index]);}
    function setBoard(progress,index,marks){const value=normalize(progress),id=idAt(index),level=levels[index];value.currentId=id;value.boards[id]=cleanBoard({fingerprint:Classic.fingerprint(level),cats:[...(marks?.cats||[])],crosses:[...(marks?.crosses||[])]},level);return value;}
    function complete(progress,index){const value=normalize(progress),id=idAt(index),next=idAt(Math.min(index+1,levels.length-1));if(!value.completed.includes(id))value.completed.push(id);value.currentId=next;return value;}
    function facts(progress=read()){
      const value=normalize(progress);let marks=0;for(let index=0;index<levels.length;index++){const record=board(value,index);marks+=record.cats.length+record.crosses.length;}
      const current=Math.max(0,indexOf(value.currentId));return{hasProgress:value.completed.length>0||marks>0||current>0,marks,completed:value.completed.length,current};
    }
    return{schema:SCHEMA,packId,key,legacyKey,read,write,clear,board,setBoard,complete,facts,idAt,indexOf,blank};
  }
  return{create,SCHEMA,DEFAULT_PACK_ID,LEGACY_KEY,PREFIX};
});
