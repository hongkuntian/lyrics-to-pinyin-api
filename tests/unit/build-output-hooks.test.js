import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as packaging from '../../scripts/build-output.mjs';

test('explicit static carrier prevents API helper auto-discovery and redundant package hooks',async()=>{
 const config=JSON.parse(await readFile(new URL('../../vercel.json',import.meta.url)));
 const pkg=JSON.parse(await readFile(new URL('../../package.json',import.meta.url)));
 // Production CLI 64.0.2 installs its own build-utils 14.21.0 next to this carrier.
 // The app's node24.0.2 builder separately resolves its 14.21.2 peer.
 assert.deepEqual(config.builds,[{src:'package.json',use:'@vercel/static-build@21.0.0'}]);
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
