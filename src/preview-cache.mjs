export function previewPriority(pageCount, focus, direction=1, radius=8) {
  const result=[],seen=new Set();
  const add=n=>{if(n>=1&&n<=pageCount&&!seen.has(n)){seen.add(n);result.push(n);}};
  add(focus);
  for(let offset=1;offset<=radius;offset++){add(focus+direction*offset);add(focus-direction*offset);}
  return result;
}

export class PreviewCache {
  constructor({maxBytes=48*1024*1024,onEvict=()=>{}}={}){this.maxBytes=maxBytes;this.onEvict=onEvict;this.items=new Map();this.bytes=0;}
  get(id){const value=this.items.get(id);if(value){this.items.delete(id);this.items.set(id,value);}return value;}
  peek(id){return this.items.get(id);}
  has(id){return this.items.has(id);}
  set(id,value,protectedIds=new Set()){
    if(value.bytes>this.maxBytes)return false;
    this.delete(id);this.items.set(id,value);this.bytes+=value.bytes;
    for(const key of this.items.keys()){
      if(this.bytes<=this.maxBytes)break;
      if(!protectedIds.has(key)&&key!==id)this.delete(key);
    }
    if(this.bytes>this.maxBytes){this.delete(id);return false;}
    return true;
  }
  delete(id){const old=this.items.get(id);if(old){this.items.delete(id);this.bytes-=old.bytes;this.onEvict(id,old);}}
  clear(){for(const id of [...this.items.keys()])this.delete(id);}
  snapshot(){return{pages:this.items.size,encodedBytes:this.bytes,maxEncodedBytes:this.maxBytes};}
}
