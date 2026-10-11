/** Private local configuration input. No key is printed or included in distribution defaults. */
process.stdin.setRawMode?.(true);process.stdin.resume();
console.log('Ready for private local model configuration on stdin (hidden).');
const config=await new Promise((resolve,reject)=>{let data='';const receive=chunk=>{data+=chunk.toString();if(data.length>20000)return reject(new Error('Configuration too large'));if(data.includes('\n')){process.stdin.off('data',receive);process.stdin.pause();try{resolve(JSON.parse(data.slice(0,data.indexOf('\n'))));}catch{reject(new Error('Invalid configuration'));}}};process.stdin.on('data',receive);});
const response=await fetch('http://127.0.0.1:4310/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providerId:'openrouter',baseUrl:'https://openrouter.ai/api/v1',model:'minimax/minimax-m3',apiKey:config.apiKey,usageEnabled:true})});
const value=await response.json();console.log(JSON.stringify({status:response.status,saved:value.saved,hasKey:value.hasKey,usageEnabled:value.usageEnabled,error:value.error}));
