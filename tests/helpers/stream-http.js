import {EventEmitter} from 'node:events';
export function streamResponse() {
 const res=new EventEmitter();Object.assign(res,{statusCode:200,headers:{},chunks:[],setHeader(k,v){this.headers[k]=v;},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;},write(v){this.chunks.push(v);return true;},end(){this.ended=true;}});return res;
}
export const frames=res=>res.chunks.map(JSON.parse);
