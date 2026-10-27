const statusByCode=Object.freeze({invalid_request:400,unauthorized:401,forbidden:403,not_found:404,
 conflict:409,expired:410,rate_limited:429,unavailable:503});

/** Public errors contain a stable code only, never a room, credential or profile. */
export class SessionV2Error extends Error {
 constructor(code){
  super(Object.hasOwn(statusByCode,code)?code:'unavailable');
  this.name='SessionV2Error';this.code=this.message;this.status=statusByCode[this.code];
 }
}

// Internal transaction-only classification. The existing receipt gateway owns
// the bounded retry; this signal carries only the already-supported SQLSTATE,
// never the original error or its database fields. It is not a public error.
const transactionSignals=new WeakSet();
export function transactionRetrySignal(error){
 if(error instanceof SessionV2Error)return null;
 if(error&&transactionSignals.has(error))return error;
 const code=error?.code;
 if(code!=='40001'&&code!=='40P01')return null;
 const signal=new Error('transaction_retry');signal.code=code;
 transactionSignals.add(signal);return Object.freeze(signal);
}
