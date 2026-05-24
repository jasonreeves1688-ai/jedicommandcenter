(function(){
  'use strict';
  function post(type,score){
    try{ window.parent.postMessage({type:type,score:Number(score)||0},'*'); }catch(e){}
  }
  window.ReevesScore    = function(s){ post('REEVES_SCORE',s); };
  window.ReevesGameOver = function(s){ post('REEVES_GAME_OVER',s); };
  console.log('[Reeves Bridge] Loaded.');
})();
