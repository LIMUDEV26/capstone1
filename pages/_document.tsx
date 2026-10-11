import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="icon" href="/favicon.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </Head>
      <body>
        {/*
          Strip `bis_skin_checked` before React hydrates. That attribute is
          injected into every <div> by the Avast/AVG "Browser Integration"
          extension, so the DOM no longer matches server HTML and React logs
          "A tree hydrated but some attributes ... didn't match". This is
          environmental (not an app bug): the observer removes the attribute
          as soon as the extension adds it. CSP already allows 'unsafe-inline'
          (see next.config.ts), so this first-party inline script runs.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var ATTR='bis_skin_checked';function clean(root){try{if(!root)return;if(root.hasAttribute&&root.hasAttribute(ATTR)){try{root.removeAttribute(ATTR);}catch(e){}}if(root.querySelectorAll){var els=root.querySelectorAll('['+ATTR+']');for(var i=0;i<els.length;i++){try{els[i].removeAttribute(ATTR);}catch(e){}}}}catch(e){}}clean(document.documentElement);var obs=new MutationObserver(function(muts){for(var m=0;m<muts.length;m++){var t=muts[m];if(t.type==='attributes'&&t.attributeName===ATTR){try{t.target.removeAttribute(ATTR);}catch(e){}}else if(t.addedNodes){for(var n=0;n<t.addedNodes.length;n++){var node=t.addedNodes[n];if(node&&node.nodeType===1){clean(node);}}}}});obs.observe(document.documentElement,{attributes:true,attributeFilter:[ATTR],childList:true,subtree:true});}catch(e){}})();`,
          }}
        />
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
