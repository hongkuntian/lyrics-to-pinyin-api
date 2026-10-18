import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as packaging from '../../scripts/build-output.mjs';

test('explicit static carrier prevents API helper auto-discovery and redundant package hooks',async()=>{
 const config=JSON.parse(await readFile(new URL('../../vercel.json',import.meta.url)));
 const pkg=JSON.parse(await readFile(new URL('../../package.json',import.meta.url)));
 // Hosted builds can select different CLI versions. A default runtime spec
 // resolves to that CLI's bundled carrier and matching build-utils peer.
 assert.deepEqual(config.builds,[{src:'package.json',use:'@vercel/static-build'}]);
 assert.equal(config.functions,undefined);
 assert.equal(config.crons,undefined,'Build Output owns cron configuration; the CLI appends top-level duplicates');
 assert.deepEqual(packaging.manifest.crons,[{path:'/api/review-reports',schedule:'0 8 * * *'}]);
 assert.equal(config.buildCommand,'node scripts/build-output.mjs');
 assert.equal(pkg.scripts.build,config.buildCommand);
 assert.equal(pkg.scripts['vercel-build'],undefined);
 assert.equal(pkg.scripts['now-build'],undefined);
});

test('inner function bundles cannot rediscover any package lifecycle build script',()=>{
 const pkg={name:'fixture',main:'api/main.js',dependencies:{fixture:'1.0.0'},
  scripts:{build:'recursive', 'vercel-build':'recursive', 'now-build':'recursive',prebuild:'recursive',postbuild:'recursive',start:'unused'}};
 const isolated=packaging.isolatedBuilderPackage(pkg);
 assert.deepEqual(isolated.scripts,{});
 assert.equal(isolated.main,pkg.main);
 assert.deepEqual(isolated.dependencies,pkg.dependencies);
 assert.equal(pkg.scripts.build,'recursive');
});

test('Build Output retains streaming capability alongside actual runtime and processed triggers',()=>{
 const lambda={runtime:'nodejs24.x',handler:'api/music-romanize.js',launcherType:'Nodejs',shouldAddHelpers:true,shouldAddSourcemapSupport:false,supportsResponseStreaming:true,maxDuration:300,regions:['iad1'],experimentalTriggers:[{type:'queue/v1beta',consumer:'actual-consumer'}]};
 const serialized=JSON.parse(JSON.stringify(packaging.runtimeConfiguration(lambda)));
 assert.equal(serialized.supportsResponseStreaming,true);assert.equal(serialized.runtime,'nodejs24.x');assert.equal(serialized.handler,lambda.handler);assert.deepEqual(serialized.experimentalTriggers,lambda.experimentalTriggers);assert.deepEqual(serialized.regions,lambda.regions);assert.equal(serialized.maxDuration,300);
});
