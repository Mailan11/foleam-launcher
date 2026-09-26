'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),yazl=require('yazl');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json');
const files=new Set();
function add(name){
 const file=path.join(root,name),stat=fs.lstatSync(file);
 if(stat.isSymbolicLink())throw Error('Refusing symlink: '+name);
 if(stat.isDirectory()){for(const child of fs.readdirSync(file))add(name+'/'+child);return;}
 if(!stat.isFile())throw Error('Not a regular file: '+name);
 if(!/\.(?:js|cjs|css|html|json|md|png|ico|txt|nsh)$/i.test(name)&&!/(?:LICENSE|NOTICE)$/i.test(name))throw Error('Unexpected source file: '+name);
 files.add(name);
}
for(const name of pkg.build.files){if(name==='assets/default-skins/**/*')add('assets/default-skins');else if(name==='vendor/*')add('vendor');else if(name.includes('*'))throw Error('Unreviewed glob');else add(name);}
for(const name of ['package-lock.json','assets/foleam.ico','build/installer.nsh','scripts/prepare-installer.cjs','scripts/package-source.cjs','SOURCE-README.md','test-security.cjs','test-updates.cjs','test-build-manager.cjs','test-installer-template.cjs'])add(name);
const deny=/(?:^|\/)(?:accounts\.json|config\.json|\.env.*|minecraft_data|node_modules|dist|\.git|\.cache)(?:\/|$)|\.(?:pfx|p12|pem|key|log)$/i;
for(const name of files)if(deny.test(name))throw Error('Private file blocked: '+name);
const hashes=[];
for(const name of [...files].sort()){
 const bytes=fs.readFileSync(path.join(root,name));
 if(/\.(?:js|cjs|json|html|md)$/.test(name)&&!name.startsWith('vendor/')){
  const text=bytes.toString('utf8');
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}/.test(text))throw Error('Potential credential in '+name);
 }
 hashes.push(crypto.createHash('sha256').update(bytes).digest('hex')+'  '+name);
}
const output=path.join(root,'dist',`Foleam-Launcher-Source-${pkg.version}.zip`);fs.mkdirSync(path.dirname(output),{recursive:true});
const zip=new yazl.ZipFile();for(const name of [...files].sort())zip.addFile(path.join(root,name),name);
zip.addBuffer(Buffer.from(hashes.join('\n')+'\n'),'SOURCE-SHA256.txt');
const stream=fs.createWriteStream(output);zip.outputStream.pipe(stream);zip.end();
stream.on('close',()=>{const hash=crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');fs.writeFileSync(output+'.sha256',hash+'  '+path.basename(output)+'\n');console.log(JSON.stringify({file:output,files:files.size,sha256:hash}));});
zip.outputStream.on('error',error=>{console.error(error.message);process.exitCode=1;});
