/* Locker 1.8 input controller. Key identifiers are set-1 physical positions. */
"use strict";
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rows = [[2,"1234567890"],[16,"qwertyuiop"],[30,"asdfghjkl"],[44,"zxcvbnm"]];
const printable = Object.fromEntries(rows.flatMap(([n,s]) => [...s].map((c,i)=>[n+i,c])));
class Entry {
  constructor() { this.value=""; this.cursor=0; this.anchor=0; this.shift=false; }
  insert(s) {
    const lo=Math.min(this.cursor,this.anchor), hi=Math.max(this.cursor,this.anchor);
    this.value=this.value.slice(0,lo)+s+this.value.slice(hi);
    this.cursor=this.anchor=lo+s.length;
  }
  dispatch(e) {
    if(e.kind==="blur") { this.shift=false; return; }
    if(e.kind==="click") { this.insert(e.symbol); return; }
    if(e.kind!=="key") return;
    if(e.scan===42) { this.shift=!!e.down; return; }
    if(!e.down) return;
    const selected=this.cursor!==this.anchor;
    if(e.scan===14) {
      if(selected) this.insert("");
      else if(this.cursor) { this.anchor=this.cursor-1; this.insert(""); }
    } else if(e.scan===75 || e.scan===77) {
      if(!this.shift && selected)
        this.cursor=e.scan===75?Math.min(this.cursor,this.anchor):Math.max(this.cursor,this.anchor);
      else this.cursor=Math.max(0,Math.min(this.value.length,this.cursor+(e.scan===75?-1:1)));
      if(!this.shift) this.anchor=this.cursor;
    } else if(e.scan===71 || e.scan===79) {
      this.cursor=e.scan===71?0:this.value.length;
      if(!this.shift) this.anchor=this.cursor;
    } else if(printable[e.scan]) {
      let c=printable[e.scan];
      if(this.shift) c=/[a-z]/.test(c)?c.toUpperCase():")!@#$%^&*("[Number(c)];
      this.insert(c);
    }
  }
}
if(typeof module!=="undefined") {
  module.exports={Entry,alphabet};
  if(require.main===module) {
    let input="";
    process.stdin.on("data",b=>input+=b);
    process.stdin.on("end",()=>{
      const entry=new Entry();
      for(const e of JSON.parse(input)) entry.dispatch(e);
      process.stdout.write(JSON.stringify({value:entry.value,cursor:entry.cursor,anchor:entry.anchor}));
    });
  }
}
if(typeof document!=="undefined") {
  const entry=new Entry(), display=document.querySelector("output"), pad=document.querySelector("#pad");
  const paint=()=>display.textContent="•".repeat(entry.value.length);
  const codeMap={Backspace:14,ArrowLeft:75,ArrowRight:77,Home:71,End:79,ShiftLeft:42};
  for(const [scan,c] of Object.entries(printable)) codeMap[/[a-z]/.test(c)?"Key"+c.toUpperCase():"Digit"+c]=Number(scan);
  for(const type of ["keydown","keyup"]) document.addEventListener(type,e=>{
    if(codeMap[e.code]!==undefined) {e.preventDefault();entry.dispatch({kind:"key",scan:codeMap[e.code],down:type==="keydown"});paint();}
  });
  window.addEventListener("blur",()=>entry.dispatch({kind:"blur"}));
  document.querySelector("#shuffle").onclick=()=>{
    const letters=[...alphabet];
    for(let i=letters.length-1;i>0;i--) {const j=crypto.getRandomValues(new Uint32Array(1))[0]%(i+1);[letters[i],letters[j]]=[letters[j],letters[i]];}
    pad.replaceChildren();
    for(const symbol of letters) {
      const b=document.createElement("button");b.setAttribute("aria-label",symbol);b.tabIndex=-1;
      b.style.backgroundPosition=`-${alphabet.indexOf(symbol)*64}px 0px`;
      b.onclick=()=>{entry.dispatch({kind:"click",symbol});paint();};pad.append(b);
    }
  };
  document.querySelector("#shuffle").click();
}
