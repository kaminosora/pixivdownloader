import {build} from 'esbuild';
import {mkdir,cp,readFile,writeFile,readdir} from 'node:fs/promises';
import {zipSync} from 'fflate';
await mkdir('dist',{recursive:true});
await cp('static','dist',{recursive:true});
await build({entryPoints:['src/background.js','src/offscreen.js','src/panel.js','src/content.js','src/choose.js'],outdir:'dist',bundle:true,format:'esm',target:'chrome116',legalComments:'eof'});
await mkdir('dist/licenses',{recursive:true});
for(const [name,file] of [['fflate','LICENSE'],['gifenc','LICENSE.md'],['mediabunny','LICENSE']])await cp(`node_modules/${name}/${file}`,`dist/licenses/${name}.txt`);
// Ship the corresponding unmodified MPL source alongside the bundled library.
const sourceFiles={};
async function collectSource(dir,prefix){for(const entry of await readdir(dir,{withFileTypes:true})){const from=`${dir}/${entry.name}`,to=`${prefix}/${entry.name}`;if(entry.isDirectory())await collectSource(from,to);else sourceFiles[to]=new Uint8Array(await readFile(from));}}
await collectSource('node_modules/mediabunny/src','mediabunny-1.64.0/src');
for(const file of ['LICENSE','package.json','README.md'])sourceFiles[`mediabunny-1.64.0/${file}`]=new Uint8Array(await readFile(`node_modules/mediabunny/${file}`));
await writeFile('dist/licenses/mediabunny-1.64.0-source.zip',zipSync(sourceFiles,{level:6}));
await writeFile('dist/licenses/NOTICE.txt','Mediabunny 1.64.0 by Vanilagy, MPL-2.0. Unmodified corresponding library source is included in mediabunny-1.64.0-source.zip. Upstream: https://github.com/Vanilagy/mediabunny/tree/v1.64.0\nProject-specific code remains MIT. gifenc 1.0.3 and fflate 0.8.2 are MIT; licenses included.\n');
const manifest=JSON.parse(await readFile('dist/manifest.json','utf8'));
console.log(`Built ${manifest.name} v${manifest.version} in dist/`);
