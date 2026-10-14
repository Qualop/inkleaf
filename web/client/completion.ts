import type { CompletionSource } from '@codemirror/autocomplete';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';

const emojiNames:readonly (readonly [string,string])[]=[
  ['smile','😄'],['smiley','😃'],['grinning','😀'],['grin','😁'],
  ['joy','😂'],['rofl','🤣'],['wink','😉'],['blush','😊'],
  ['heart_eyes','😍'],['kissing_heart','😘'],['thinking','🤔'],
  ['neutral_face','😐'],['expressionless','😑'],['sob','😭'],['cry','😢'],
  ['sweat_smile','😅'],['sunglasses','😎'],['+1','👍'],['-1','👎'],
  ['thumbs_up','👍'],['thumbs_down','👎'],['clap','👏'],['pray','🙏'],
  ['wave','👋'],['muscle','💪'],['heart','❤️'],['broken_heart','💔'],
  ['fire','🔥'],['star','⭐'],['sparkles','✨'],['tada','🎉'],
  ['party_popper','🎉'],['rocket','🚀'],['warning','⚠️'],
  ['white_check_mark','✅'],['check_mark','✅'],['x','❌'],['eyes','👀'],
  ['coffee','☕'],['book','📖'],['memo','📝'],['bulb','💡'],['bug','🐛'],
  ['cat','🐱'],['dog','🐶'],['sunny','☀️'],['rainbow','🌈'],['100','💯'],
];

export const emojiCompletionSource:CompletionSource=context=>{
  const token=context.matchBefore(/:[a-z0-9_+-]*$/i);
  if(!token)return null;
  const before=context.state.doc.sliceString(context.state.doc.lineAt(token.from).from,token.from);
  if(before.endsWith(':') || /:[a-z0-9_+-]+$/i.test(before))return null;
  const word=context.state.doc.sliceString(context.state.doc.lineAt(context.pos).from,context.pos).match(/\S+$/)?.[0] ?? '';
  if(/^(?:https?|ftp|file|mailto):/i.test(word))return null;

  const initial=syntaxTree(context.state);
  const tree=initial.length>=context.pos?initial:ensureSyntaxTree(context.state,context.pos,10);
  if(!tree)return null;
  // resolve, rather than resolveInner, retains Markdown ancestors around mounted code languages.
  for(let node=tree.resolve(context.pos,-1);node;node=node.parent!)
    if(['InlineCode','FencedCode','CodeBlock','URL','Autolink'].includes(node.name))return null;

  const prefix=token.text.slice(1).toLowerCase();
  const options=emojiNames.filter(([name])=>name.startsWith(prefix)).map(([name,emoji])=>({label:`:${name}:`,apply:emoji,detail:emoji,type:'text'}));
  if(!options.length)return null;
  // Requery each prefix so a narrowed option list cannot become stale after backspacing.
  return {from:token.from,to:context.pos,options,filter:false};
};
