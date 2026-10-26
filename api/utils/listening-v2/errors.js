const statusByCode=Object.freeze({invalid_request:400,unauthorized:401,forbidden:403,not_found:404,
 conflict:409,expired:410,rate_limited:429,unavailable:503});

/** Public errors contain a stable code only, never a room, credential or profile. */
export class SessionV2Error extends Error {
 constructor(code){
  super(Object.hasOwn(statusByCode,code)?code:'unavailable');
  this.name='SessionV2Error';this.code=this.message;this.status=statusByCode[this.code];
 }
}
