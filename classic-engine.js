/* Classic solo Meowdoku: deterministic validation, solving and explainable hints. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatClassic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function validPlacement(size, regions, placed, index) {
    const row = Math.floor(index / size), col = index % size, region = regions[index];
    for (const other of placed) {
      const otherRow = Math.floor(other / size), otherCol = other % size;
      if (otherRow === row || otherCol === col || regions[other] === region) return false;
      if (Math.abs(otherRow - row) <= 1 && Math.abs(otherCol - col) <= 1) return false;
    }
    return true;
  }

  function givens(puzzle) {
    return Array.isArray(puzzle?.givens) ? [...new Set(puzzle.givens)] : [];
  }

  function fingerprint(puzzle) {
    const fixed=givens(puzzle).slice().sort((a,b)=>a-b);
    return `classic-v1:${puzzle?.size}:${Array.isArray(puzzle?.regions)?puzzle.regions.join(','):''}:g:${fixed.join(',')}`;
  }

  function enumerate(puzzle, marks, limit = Infinity) {
    const size = puzzle.size, regions = puzzle.regions, cats = new Set([...givens(puzzle),...(marks?.cats || [])]), crosses = new Set(marks?.crosses || []);
    const fixedRows = new Set(), fixedCols = new Set(), fixedRegions = new Set();
    for (const index of cats) {
      if (!Number.isInteger(index) || index < 0 || index >= size * size || !validPlacement(size, regions, [...cats].filter(value => value !== index), index)) return [];
      fixedRows.add(Math.floor(index / size)); fixedCols.add(index % size); fixedRegions.add(regions[index]);
    }
    const solutions = [], rows = Array.from({length:size}, (_, row) => row).filter(row => !fixedRows.has(row));
    function visit(position, placed, cols, usedRegions) {
      if (solutions.length >= limit) return;
      if (position === rows.length) { solutions.push([...cats, ...placed].sort((a,b) => a-b)); return; }
      const row = rows[position];
      for (let col = 0; col < size; col++) {
        const index = row * size + col, region = regions[index];
        if (crosses.has(index) || cols.has(col) || usedRegions.has(region) || !validPlacement(size, regions, [...cats, ...placed], index)) continue;
        cols.add(col); usedRegions.add(region); placed.push(index);
        visit(position + 1, placed, cols, usedRegions);
        placed.pop(); usedRegions.delete(region); cols.delete(col);
      }
    }
    visit(0, [], new Set(fixedCols), new Set(fixedRegions));
    return solutions;
  }

  function candidates(puzzle, marks) {
    const cats = new Set([...givens(puzzle),...(marks?.cats || [])]), crosses = new Set(marks?.crosses || []), result = [];
    for (let index = 0; index < puzzle.size * puzzle.size; index++) {
      if (!cats.has(index) && !crosses.has(index) && validPlacement(puzzle.size, puzzle.regions, cats, index)) result.push(index);
    }
    return result;
  }

  function unitName(type, value) {
    return type === 'row' ? `第 ${value + 1} 橫排` : type === 'column' ? `第 ${value + 1} 直欄` : `色區 ${value + 1}`;
  }

  function combinations(values, count, start = 0, prefix = [], result = []) {
    if (prefix.length === count) { result.push(prefix.slice()); return result; }
    for (let index = start; index <= values.length - (count - prefix.length); index++) {
      prefix.push(values[index]); combinations(values, count, index + 1, prefix, result); prefix.pop();
    }
    return result;
  }

  function enumerateLogicalActions(puzzle, marks) {
    const cats=new Set([...givens(puzzle),...(marks?.cats||[])]),crosses=new Set(marks?.crosses||[]),open=candidates(puzzle,{cats,crosses}),units=[],actions=[];
    const add=action=>actions.push({...action,source:'logic'}),valueOf=(type,index)=>type==='row'?Math.floor(index/puzzle.size):type==='column'?index%puzzle.size:puzzle.regions[index];
    for(let value=0;value<puzzle.size;value++)for(const type of ['row','column','region'])units.push({type,value,cells:open.filter(index=>valueOf(type,index)===value),done:[...cats].some(index=>valueOf(type,index)===value)});
    for(const unit of units)if(!unit.done&&unit.cells.length===1)add({kind:'cat',index:unit.cells[0],related:unit.cells,technique:`${unit.type}-single`,premises:unit.cells.map(index=>({kind:'candidate',index})),text:`${unitName(unit.type,unit.value)}只剩這一格能放貓。`});
    for(const cat of cats){const row=Math.floor(cat/puzzle.size),col=cat%puzzle.size;for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){const r=row+dr,c=col+dc,index=r*puzzle.size+c;if((dr||dc)&&r>=0&&c>=0&&r<puzzle.size&&c<puzzle.size&&!cats.has(index)&&!crosses.has(index))add({kind:'cross',index,related:[cat,index],technique:'adjacent',premises:[{kind:'cat',index:cat}],housekeeping:true,text:'貓的周圍八格都不能再放貓。'});}}
    for(const unit of units.filter(value=>!value.done&&value.cells.length>1)){
      const rows=new Set(unit.cells.map(index=>Math.floor(index/puzzle.size))),cols=new Set(unit.cells.map(index=>index%puzzle.size));
      if(unit.type==='region'&&rows.size===1){const row=[...rows][0];for(const index of open)if(Math.floor(index/puzzle.size)===row&&puzzle.regions[index]!==unit.value)add({kind:'cross',index,related:unit.cells.concat(index),technique:'region-row',premises:unit.cells.map(index=>({kind:'candidate',index})),text:`色區 ${unit.value+1} 的貓必在第 ${row+1} 橫排，因此同排其他色區可排除。`});}
      if(unit.type==='region'&&cols.size===1){const col=[...cols][0];for(const index of open)if(index%puzzle.size===col&&puzzle.regions[index]!==unit.value)add({kind:'cross',index,related:unit.cells.concat(index),technique:'region-column',premises:unit.cells.map(index=>({kind:'candidate',index})),text:`色區 ${unit.value+1} 的貓必在第 ${col+1} 直欄，因此同欄其他色區可排除。`});}
    }
    for(const unit of units.filter(value=>!value.done&&value.cells.length>1)){const members=new Set(unit.cells);for(const index of open)if(!members.has(index)&&unit.cells.every(candidate=>!validPlacement(puzzle.size,puzzle.regions,[candidate],index)))add({kind:'cross',index,related:unit.cells.concat(index),technique:'common-conflict',premises:unit.cells.map(index=>({kind:'candidate',index})),text:`${unitName(unit.type,unit.value)}的所有候選位置都會排除這一格，因此這格不可能有貓。`});}
    for(const unit of units.filter(value=>!value.done&&value.cells.length>1&&value.type!=='region')){const regions=new Set(unit.cells.map(index=>puzzle.regions[index]));if(regions.size!==1)continue;const region=[...regions][0];for(const index of open)if(puzzle.regions[index]===region&&(unit.type==='row'?Math.floor(index/puzzle.size)!==unit.value:index%puzzle.size!==unit.value))add({kind:'cross',index,related:unit.cells.concat(index),technique:`${unit.type}-region`,premises:unit.cells.map(index=>({kind:'candidate',index})),text:`${unitName(unit.type,unit.value)}的貓必在色區 ${region+1}，因此該色區其他${unit.type==='row'?'橫排':'直欄'}可排除。`});}
    const familyLabel={row:'橫排',column:'直欄',region:'色區'},families={};for(const type of ['row','column','region'])families[type]=units.filter(unit=>unit.type===type&&!unit.done&&unit.cells.length);
    for(const sourceType of ['row','column','region'])for(const targetType of ['row','column','region'])if(sourceType!==targetType)for(const width of [2,3])for(const group of combinations(families[sourceType],width)){const targets=new Set(group.flatMap(unit=>unit.cells.map(index=>valueOf(targetType,index))));if(targets.size!==width)continue;const sources=new Set(group.map(unit=>unit.value)),sourceNames=[...sources].map(value=>value+1).join('、'),targetNames=[...targets].map(value=>value+1).join('、');for(const index of open)if(targets.has(valueOf(targetType,index))&&!sources.has(valueOf(sourceType,index)))add({kind:'cross',index,related:group.flatMap(unit=>unit.cells).concat(index),technique:`subset-${width}-${sourceType}-${targetType}`,premises:group.flatMap(unit=>unit.cells.map(index=>({kind:'candidate',index}))),text:`${familyLabel[sourceType]} ${sourceNames} 的 ${width} 隻貓只能分配在${familyLabel[targetType]} ${targetNames}；這些位置已被保留，其他${familyLabel[sourceType]}可排除。`});}
    const unique=new Map();for(const action of actions){const key=`${action.kind}:${action.index}`;if(!unique.has(key))unique.set(key,action);}return[...unique.values()];
  }

  function nextHint(puzzle, marks) {
    const fixed=new Set(givens(puzzle)),cats = new Set([...fixed,...(marks?.cats || [])]), crosses = new Set(marks?.crosses || []), open = candidates(puzzle, {cats, crosses});
    // These two checks intentionally consult the stored answer. They only repair
    // player mistakes and are clearly labeled; normal logic below never reads it.
    const wrongCat = Array.isArray(puzzle.solution) ? [...cats].find(index => !fixed.has(index)&&!puzzle.solution.includes(index)) : null;
    if (wrongCat != null) return {kind:'error',index:wrongCat,related:[wrongCat],technique:'correction',source:'answer-check',text:'答案檢查：這隻貓不是本題解答的一部分。請先移除這個標記，再繼續純推理提示。'};
    const wrongCross = Array.isArray(puzzle.solution) ? [...crosses].find(index => puzzle.solution.includes(index)) : null;
    if (wrongCross != null) return {kind:'error',index:wrongCross,related:[wrongCross],technique:'correction',source:'answer-check',text:'答案檢查：這格不應被排除。請再點一下清除 X，避免盤面無解。'};
    return enumerateLogicalActions(puzzle,{cats:[...cats].filter(index=>!fixed.has(index)),crosses})[0]||null;

    /* Legacy inlined rules below are unreachable and retained temporarily so
       existing source snapshots remain reviewable while the shared API lands. */
    const units = [];
    for (let value = 0; value < puzzle.size; value++) {
      units.push({type:'row',value,cells:open.filter(index => Math.floor(index / puzzle.size) === value),done:[...cats].some(index => Math.floor(index / puzzle.size) === value)});
      units.push({type:'column',value,cells:open.filter(index => index % puzzle.size === value),done:[...cats].some(index => index % puzzle.size === value)});
      units.push({type:'region',value,cells:open.filter(index => puzzle.regions[index] === value),done:[...cats].some(index => puzzle.regions[index] === value)});
    }
    const single = units.find(unit => !unit.done && unit.cells.length === 1);
    if (single) return {kind:'cat',index:single.cells[0],related:single.cells,technique:`${single.type}-single`,source:'logic',text:`${unitName(single.type,single.value)}只剩這一格能放貓。`};

    for (const cat of cats) {
      const row = Math.floor(cat / puzzle.size), col = cat % puzzle.size;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nextRow = row + dr, nextCol = col + dc, index = nextRow * puzzle.size + nextCol;
        if ((dr || dc) && nextRow >= 0 && nextCol >= 0 && nextRow < puzzle.size && nextCol < puzzle.size && !cats.has(index) && !crosses.has(index)) {
          return {kind:'cross',index,related:[cat,index],technique:'adjacent',source:'logic',text:'貓的周圍八格都不能再放貓。'};
        }
      }
    }

    for (const unit of units.filter(value => !value.done && value.cells.length > 1)) {
      const rows = new Set(unit.cells.map(index => Math.floor(index / puzzle.size))), cols = new Set(unit.cells.map(index => index % puzzle.size));
      if (unit.type === 'region' && rows.size === 1) {
        const row = [...rows][0], target = open.find(index => Math.floor(index / puzzle.size) === row && puzzle.regions[index] !== unit.value);
        if (target != null) return {kind:'cross',index:target,related:unit.cells.concat(target),technique:'region-row',source:'logic',text:`色區 ${unit.value + 1} 的貓必在第 ${row + 1} 橫排，因此同排其他色區可排除。`};
      }
      if (unit.type === 'region' && cols.size === 1) {
        const col = [...cols][0], target = open.find(index => index % puzzle.size === col && puzzle.regions[index] !== unit.value);
        if (target != null) return {kind:'cross',index:target,related:unit.cells.concat(target),technique:'region-column',source:'logic',text:`色區 ${unit.value + 1} 的貓必在第 ${col + 1} 直欄，因此同欄其他色區可排除。`};
      }
    }

    // Common-conflict: every possible cat in one unfinished unit conflicts
    // with the same outside cell, so that outside cell cannot contain a cat.
    // This compares public candidates only and never consults the answer.
    for (const unit of units.filter(value => !value.done && value.cells.length > 1)) {
      const members=new Set(unit.cells);
      const target=open.find(index=>!members.has(index)&&unit.cells.every(candidate=>!validPlacement(puzzle.size,puzzle.regions,[candidate],index)));
      if(target!=null)return{kind:'cross',index:target,related:unit.cells.concat(target),technique:'common-conflict',source:'logic',
        text:`${unitName(unit.type,unit.value)}的所有候選位置都會排除這一格，因此這格不可能有貓。`};
    }

    // Reverse locked candidates: a row/column confined to one region excludes
    // the rest of that region. This is direct set containment, not trial placement.
    for (const unit of units.filter(value => !value.done && value.cells.length > 1 && value.type !== 'region')) {
      const regions = new Set(unit.cells.map(index => puzzle.regions[index]));
      if (regions.size !== 1) continue;
      const region = [...regions][0], target = open.find(index => puzzle.regions[index] === region &&
        (unit.type === 'row' ? Math.floor(index / puzzle.size) !== unit.value : index % puzzle.size !== unit.value));
      if (target != null) return {kind:'cross',index:target,related:unit.cells.concat(target),technique:`${unit.type}-region`,source:'logic',
        text:`${unitName(unit.type,unit.value)}的貓必在色區 ${region + 1}，因此該色區其他${unit.type === 'row' ? '橫排' : '直欄'}可排除。`};
    }

    const familyLabel={row:'橫排',column:'直欄',region:'色區'};
    const valueOf=(type,index)=>type==='row'?Math.floor(index/puzzle.size):type==='column'?index%puzzle.size:puzzle.regions[index];
    const families={};
    for(const type of ['row','column','region'])families[type]=units.filter(unit=>unit.type===type&&!unit.done&&unit.cells.length);
    // Hall pairs/triples: if N source units can use only the same N target
    // units, those targets are reserved. No candidate is assumed and no answer
    // is enumerated to produce this deduction.
    for(const sourceType of ['row','column','region'])for(const targetType of ['row','column','region']){
      if(sourceType===targetType)continue;
      for(const width of [2,3])for(const group of combinations(families[sourceType],width)){
        const targets=new Set(group.flatMap(unit=>unit.cells.map(index=>valueOf(targetType,index))));
        if(targets.size!==width)continue;
        const sources=new Set(group.map(unit=>unit.value));
        const target=open.find(index=>targets.has(valueOf(targetType,index))&&!sources.has(valueOf(sourceType,index)));
        if(target==null)continue;
        const sourceNames=[...sources].map(value=>value+1).join('、'),targetNames=[...targets].map(value=>value+1).join('、');
        return {kind:'cross',index:target,related:group.flatMap(unit=>unit.cells).concat(target),technique:`subset-${width}-${sourceType}-${targetType}`,source:'logic',
          text:`${familyLabel[sourceType]} ${sourceNames} 的 ${width} 隻貓只能分配在${familyLabel[targetType]} ${targetNames}；這些位置已被保留，其他${familyLabel[sourceType]}可排除。`};
      }
    }
    return null;
  }

  function validate(puzzle) {
    const errors = [], size = puzzle?.size, regions = puzzle?.regions, fixed=givens(puzzle);
    if (!Number.isInteger(size) || size < 4 || size > 15) errors.push('invalid size');
    if (!Array.isArray(regions) || regions.length !== size * size) errors.push('invalid regions');
    if (errors.length) return {valid:false,errors,solutions:0};
    if (!Array.isArray(puzzle?.givens)&&puzzle?.givens!=null) errors.push('invalid givens');
    if (fixed.some(index=>!Number.isInteger(index)||index<0||index>=size*size)||fixed.length!==(puzzle?.givens||[]).length) errors.push('invalid givens');
    if (fixed.some(index=>!validPlacement(size,regions,fixed.filter(value=>value!==index),index))) errors.push('conflicting givens');
    const labels = new Set(regions);
    if (labels.size !== size || [...labels].some(value => !Number.isInteger(value) || value < 0 || value >= size)) errors.push('invalid region labels');
    for (let region = 0; region < size; region++) {
      const cells = regions.map((value,index) => value === region ? index : -1).filter(index => index >= 0), seen = new Set(cells.slice(0,1)), queue = cells.slice(0,1);
      while (queue.length) {
        const index = queue.shift(), row = Math.floor(index / size), col = index % size;
        for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]) { const r=row+dr,c=col+dc,next=r*size+c; if(r>=0&&c>=0&&r<size&&c<size&&regions[next]===region&&!seen.has(next)){seen.add(next);queue.push(next);} }
      }
      if (seen.size !== cells.length) errors.push(`region ${region} disconnected`);
    }
    const solutions = errors.length ? [] : enumerate(puzzle, null, 2);
    if (solutions.length !== 1) errors.push(`expected one solution, found ${solutions.length}`);
    if (solutions.length===1&&Array.isArray(puzzle.solution)&&puzzle.solution.slice().sort((a,b)=>a-b).join(',')!==solutions[0].join(',')) errors.push('stored solution mismatch');
    return {valid:!errors.length,errors,solutions:solutions.length,solution:solutions[0]};
  }

  return {enumerate,candidates,enumerateLogicalActions,nextHint,validate,validPlacement,fingerprint,givens};
});
