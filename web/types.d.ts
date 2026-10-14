declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';
  export default function plugin(md:MarkdownIt,options?:{enabled?:boolean;label?:boolean}):void;
}
declare module 'markdown-it-footnote' {
  import type {PluginSimple} from 'markdown-it';
  const plugin:PluginSimple;export default plugin;
}
declare module 'markdown-it-mark' {
  import type {PluginSimple} from 'markdown-it';
  const plugin:PluginSimple;export default plugin;
}
declare module 'markdown-it-sub' {
  import type {PluginSimple} from 'markdown-it';
  const plugin:PluginSimple;export default plugin;
}
declare module 'markdown-it-sup' {
  import type {PluginSimple} from 'markdown-it';
  const plugin:PluginSimple;export default plugin;
}
