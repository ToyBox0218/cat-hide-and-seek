/* Shared, mode-neutral status and live-region presentation. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.CatStatusPresenter=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function resolve(target,documentRef){
    if(target&&typeof target==='object')return target;
    const documentValue=documentRef||(typeof document!=='undefined'?document:null);
    return typeof target==='string'&&documentValue?documentValue.querySelector(target):null;
  }
  function present(target,message,options={}){
    const node=resolve(target,options.document);if(!node)return false;
    const value=message==null?'':String(message),key=options.key==null?value:String(options.key);
    if(options.role!==false&&!node.getAttribute('role'))node.setAttribute('role',options.role||'status');
    if(options.live!==false&&!node.getAttribute('aria-live'))node.setAttribute('aria-live',options.live||'polite');
    if(options.atomic!==false&&!node.getAttribute('aria-atomic'))node.setAttribute('aria-atomic','true');
    if(options.hidden!=null){node.hidden=Boolean(options.hidden);node.classList?.toggle('hidden',Boolean(options.hidden));}
    const changed=node.dataset?.statusKey!==key||node.textContent!==value;if(!changed)return false;
    node.textContent=value;if(node.dataset)node.dataset.statusKey=key;return true;
  }
  function clear(target,options={}){return present(target,'',{...options,key:options.key??''});}
  return{present,clear};
});
