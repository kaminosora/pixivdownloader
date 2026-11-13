import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {zipSync,unzipSync} from 'fflate';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
execFileSync(process.execPath,['scripts/build.mjs'],{stdio:'inherit'});
const files={};
const extensionFiles=['background.js','choose.html','choose.js','content.js','manifest.json','offscreen.html','offscreen.js','panel.css','panel.html','panel.js','licenses/NOTICE.txt','licenses/fflate.txt','licenses/gifenc.txt','licenses/mediabunny.txt','licenses/mediabunny-1.64.0-source.zip'];
// Fail closed if stale or unexpected build files could enter a public release.
async function inventory(dir,prefix=''){const names=[];for(const e of await readdir(dir,{withFileTypes:true})){const relative=`${prefix}${e.name}`;if(e.isSymbolicLink())throw new Error(`Unexpected symlink: ${relative}`);if(e.isDirectory())names.push(...await inventory(`${dir}/${e.name}`,`${relative}/`));else names.push(relative);}return names.sort();}
if(JSON.stringify(await inventory('dist'))!==JSON.stringify(extensionFiles.slice().sort()))throw new Error('dist contains missing or unexpected files; inspect the build before packaging');
for(const file of extensionFiles)files[`extension/${file}`]=new Uint8Array(await readFile(`dist/${file}`));
for(const file of ['README.md','LICENSE','docs/verification.md','docs/verification-browser.json','docs/verification-video.json','docs/verification-unit.txt','docs/verification-network.json','docs/verification-hash-fix.json','docs/verification-native-picker.json'])files[file]=new Uint8Array(await readFile(file));
const bytes=zipSync(files,{level:6});const unzipped=unzipSync(bytes);
for(const [name,data]of Object.entries(files)){if(!Buffer.from(data).equals(Buffer.from(unzipped[name])))throw new Error(`ZIP verification failed: ${name}`);}
await mkdir('releases',{recursive:true});
const {version}=JSON.parse(await readFile('dist/manifest.json','utf8'));
const name=`pixiv-original-downloader-${version}.zip`;await writeFile(`releases/${name}`,bytes);
const hash=createHash('sha256').update(bytes).digest('hex');await writeFile('releases/SHA256SUMS.txt',`${hash}  ${name}\n`);
console.log(`Verified ${Object.keys(files).length} archive files; ${bytes.length} bytes\nSHA256 ${hash}`);
