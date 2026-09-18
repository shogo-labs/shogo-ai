// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import type { NoteNode } from "../../lib/notes-api";
import { NOTES_DESIGN_TOKENS as T } from "./notes-design-tokens";

export type RichNotesEditorHandle = {
  focus: () => void;
  blur: () => void;
  command: (name: string, value?: string) => void;
};

export function documentForText(text: string): NoteNode {
  const paragraphs = text
    .split(/\n+/)
    .map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    }));
  return {
    type: "doc",
    content: paragraphs.length ? paragraphs : [{ type: "paragraph" }],
  };
}

function escape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function initialHtml(document: NoteNode) {
  const inline = (node: NoteNode): string => {
    let html =
      node.text !== undefined
        ? escape(node.text)
        : (node.content || []).map(inline).join("");
    for (const mark of node.marks || []) {
      if (mark.type === "bold") html = `<strong>${html}</strong>`;
      if (mark.type === "italic") html = `<em>${html}</em>`;
      if (mark.type === "fontSize" && typeof mark.attrs?.size === "string")
        html = `<span data-font-size="${escape(mark.attrs.size)}" style="font-size:${escape(mark.attrs.size)}px">${html}</span>`;
    }
    return html;
  };
  const block = (node: NoteNode): string => {
    if (node.type === "image" && typeof node.attrs?.assetId === "string")
      return `<img data-asset-id="${escape(node.attrs.assetId)}" alt="Attachment" />`;
    const content = (node.content || []).map(inline).join("");
    if (node.type === "heading") return `<h2>${content}</h2>`;
    if (node.type === "bulletList")
      return `<ul>${(node.content || []).map((item) => `<li>${(item.content || []).map(inline).join("")}</li>`).join("")}</ul>`;
    if (node.type === "orderedList")
      return `<ol>${(node.content || []).map((item) => `<li>${(item.content || []).map(inline).join("")}</li>`).join("")}</ol>`;
    return `<p>${content}</p>`;
  };
  return (document.content || []).map(block).join("");
}

const HTML = (
  document: NoteNode,
) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>*{box-sizing:border-box}html,body{margin:0;padding:0;background:#141313;color:#ffffff;font-family:Poppins,-apple-system,BlinkMacSystemFont,sans-serif;font-size:16px;line-height:1.35}body{min-height:100%;padding:0 0 24px}#editor{outline:none;min-height:100%;padding:0}.placeholder:before{content:'Add context for agent';display:block;color:#c4c7c5}p{margin:0 0 8px}h2{font-size:22px}ul,ol{padding-left:24px}img[data-asset-id]{display:block;max-width:100%;max-height:320px;object-fit:cover;border-radius:0;margin:8px 0;outline:none}span[data-font-size]{font-size:inherit}</style></head><body><div id="editor" class="placeholder" contenteditable="true" spellcheck="true">${initialHtml(document)}</div><script>
const root=document.getElementById('editor'); let savedRange=null;
function currentMarks(el){const marks=[]; let current=el.parentElement; while(current&&current!==root){const tag=current.tagName.toLowerCase(); if(tag==='strong'||tag==='b')marks.push({type:'bold'}); if(tag==='em'||tag==='i')marks.push({type:'italic'}); if(tag==='span'&&current.dataset.fontSize)marks.push({type:'fontSize',attrs:{size:current.dataset.fontSize}}); current=current.parentElement} return marks.length?marks:undefined;}
function node(el){if(el.nodeType===3){const result={type:'text',text:el.textContent||''}; const marks=currentMarks(el); return marks?{...result,marks}:result;} if(el.nodeType!==1)return null; const tag=el.tagName.toLowerCase(); if(tag==='img'&&el.dataset.assetId)return {type:'image',attrs:{assetId:el.dataset.assetId}}; if(tag==='strong'||tag==='b'||tag==='em'||tag==='i'||tag==='span') {const content=Array.from(el.childNodes).map(node).filter(Boolean); return content.length===1?content[0]:{type:'text',text:el.textContent||''};} const type=tag==='h2'?'heading':tag==='ul'?'bulletList':tag==='ol'?'orderedList':tag==='li'?'listItem':tag==='br'?'hardBreak':'paragraph'; const content=Array.from(el.childNodes).map(node).filter(Boolean); return content.length?{type,content}:{type};}
function emit(){const plainText=root.innerText||''; root.classList.toggle('placeholder',!plainText.trim()&&!root.querySelector('img')); const children=Array.from(root.children).map(node).filter(Boolean); window.ReactNativeWebView.postMessage(JSON.stringify({type:'content',document:{type:'doc',content:children.length?children:[{type:'paragraph'}]},plainText}))}
function restoreSelection(){if(!savedRange)return; const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(savedRange);}
function rememberSelection(){const selection=window.getSelection(); if(selection&&selection.rangeCount&&root.contains(selection.anchorNode))savedRange=selection.getRangeAt(0).cloneRange();}
function prepareSelection(){root.focus(); if(savedRange)restoreSelection();}
function setFontSize(size){prepareSelection(); document.execCommand('fontSize',false,'7'); root.querySelectorAll('font[size="7"]').forEach((font)=>{const span=document.createElement('span'); span.dataset.fontSize=size; span.style.fontSize=size+'px'; span.innerHTML=font.innerHTML; font.replaceWith(span)}); root.focus(); emit();}
function insertImage(value){try{const data=JSON.parse(value||'{}'); if(!data.assetId||!data.url)return; const img=document.createElement('img'); img.dataset.assetId=data.assetId; img.src=data.url; img.alt=data.name||'Attachment'; img.contentEditable='false'; const selection=window.getSelection(); if(selection&&selection.rangeCount&&root.contains(selection.anchorNode)){const range=selection.getRangeAt(0); range.deleteContents(); range.insertNode(img); range.setStartAfter(img); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);}else root.appendChild(img); root.appendChild(document.createElement('p'));}catch{}}
function insertTranscript(value){const text=(value||'').trim();if(!text)return;const paragraph=document.createElement('p');paragraph.textContent=text;root.appendChild(paragraph);const selection=window.getSelection();const range=document.createRange();range.selectNodeContents(paragraph);range.collapse(false);selection.removeAllRanges();selection.addRange(range);}
window.__notesCommand=function(name,value){prepareSelection(); if(name==='setFontSize')setFontSize(value||'16'); else if(name==='insertImage')insertImage(value); else if(name==='insertTranscript')insertTranscript(value); else document.execCommand(name,false,value||null); root.focus(); emit();};
function dismissWhenTappingCanvas(event){if(document.activeElement!==root)return;event.preventDefault();root.blur();}
window.__notesLoadDocument=function(html){root.innerHTML=html||'<p></p>';root.classList.toggle('placeholder',!root.innerText.trim()&&!root.querySelector('img'));};
root.addEventListener('input',emit); root.addEventListener('keyup',emit); root.addEventListener('focus',emit); root.addEventListener('pointerdown',dismissWhenTappingCanvas); root.addEventListener('touchstart',dismissWhenTappingCanvas,{passive:false}); document.addEventListener('selectionchange',rememberSelection); emit();
document.addEventListener('message',event=>{try{const m=JSON.parse(event.data); if(m.type==='command')window.__notesCommand(m.name,m.value); if(m.type==='focus')root.focus()}catch{}});
</script></body></html>`;

export const RichNotesEditor = forwardRef<
  RichNotesEditorHandle,
  {
    document: NoteNode;
    hydrationKey?: string;
    assetUrls?: Record<string, string>;
    onChange: (document: NoteNode, text: string) => void;
  }
>(function RichNotesEditor(
  { document, hydrationKey = "", assetUrls = {}, onChange },
  ref,
) {
  const webRef = useRef<WebView>(null);
  const webReady = useRef(false);
  const hydratedKey = useRef<string | null>(null);
  const ignoredInitialMessage = useRef(false);
  useImperativeHandle(
    ref,
    () => ({
      focus: () =>
        webRef.current?.injectJavaScript(
          "document.getElementById('editor').focus(); true;",
        ),
      blur: () =>
        webRef.current?.injectJavaScript(
          "document.getElementById('editor').blur(); true;",
        ),
      command: (name, value) =>
        webRef.current?.injectJavaScript(
          `window.__notesCommand && window.__notesCommand(${JSON.stringify(name)},${JSON.stringify(value || null)}); true;`,
        ),
    }),
    [],
  );
  // Reloading a WebView on each editor event clears the selection and can make
  // typing appear to drop or blank out. The initial document is loaded once;
  // subsequent edits are maintained inside the editor and emitted to React.
  const initialSource = useRef<string | null>(null);
  if (!initialSource.current) initialSource.current = HTML(document);
  const source = useMemo(() => ({ html: initialSource.current! }), []);
  const hydrate = () => {
    if (!webReady.current || hydratedKey.current === hydrationKey) return;
    hydratedKey.current = hydrationKey;
    webRef.current?.injectJavaScript(
      `window.__notesLoadDocument && window.__notesLoadDocument(${JSON.stringify(initialHtml(document))}); true;`,
    );
  };
  const applyAssetUrls = () => {
    if (!webReady.current || !Object.keys(assetUrls).length) return;
    webRef.current?.injectJavaScript(
      `(function(){const urls=${JSON.stringify(assetUrls)};document.querySelectorAll('img[data-asset-id]').forEach((img)=>{const url=urls[img.dataset.assetId];if(url)img.src=url;});})();true;`,
    );
  };
  useEffect(() => {
    hydrate();
  }, [document, hydrationKey]);
  useEffect(() => {
    applyAssetUrls();
  }, [assetUrls]);
  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as {
        type: string;
        document: NoteNode;
        plainText: string;
      };
      if (message.type !== "content") return; // The WebView emits once while its inline document is booting. It is not a user edit and may be stale.
      if (!ignoredInitialMessage.current) {
        ignoredInitialMessage.current = true;
        return;
      }
      onChange(message.document, message.plainText);
    } catch {
      /* editor messages are isolated */
    }
  };
  return (
    <View
      style={{ flex: 1, overflow: "hidden", backgroundColor: T.background }}
    >
      <WebView
        ref={webRef}
        source={source}
        onLoadEnd={() => {
          webReady.current = true;
          hydrate();
          applyAssetUrls();
        }}
        onMessage={onMessage}
        originWhitelist={["*"]}
        javaScriptEnabled
        scrollEnabled
        hideKeyboardAccessoryView
        containerStyle={{ flex: 1, backgroundColor: T.background }}
        style={{ flex: 1, backgroundColor: T.background }}
      />
    </View>
  );
});
