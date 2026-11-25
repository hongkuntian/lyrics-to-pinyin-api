import test from 'node:test';
import assert from 'node:assert/strict';
import {artifact,variantKey,validateBundle,publicationGrant} from '../../api/utils/prepared-editions/core.js';
import {bundle} from '../helpers/prepared-edition.js';
test('publication binds exact identities and complete artifacts; any missing or foreign content is rejected',()=>{
 const b=bundle();assert.equal(validateBundle(b),b);
 assert.throws(()=>validateBundle({...b,artifacts:b.artifacts.slice(1)}));
 assert.throws(()=>validateBundle({...b,coverage:{...b.coverage,complete:false}}));
 assert.throws(()=>validateBundle({...b,rights:{...b.rights,derivatives:false}}));
 assert.throws(()=>validateBundle({...b,artifacts:[{...b.artifacts[0],content:{}},...b.artifacts.slice(1)]}));
 assert.equal(artifact('document',{a:1}).id,artifact('document',{a:1}).id);
 assert.notEqual(variantKey({provider:'apple',catalogID:'1',storefront:'ca'}),variantKey({provider:'apple',catalogID:'1',storefront:'tw'}));
});
test('grants never imply offline or client-supplied territory and expire at source expiry',()=>{
 const b=bundle(),now=Date.now();b.rights.expiresAt=new Date(now+1000).toISOString();
 assert.equal(publicationGrant({bundle:b,generation:'1',state:'published'},'read',null,now).expiresAt,b.rights.expiresAt);
 b.rights.worldwide=false;b.rights.territories=['CA'];
 assert.throws(()=>publicationGrant({bundle:b,generation:'1',state:'published'},'read',null,now),/prepared_unavailable/);
 assert.ok(publicationGrant({bundle:b,generation:'1',state:'published'},'read','CA',now).onlineRequired);
});
