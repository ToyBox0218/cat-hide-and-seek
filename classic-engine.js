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

  function enumerate(puzzle, marks, limit = Infinity) {
    const size = puzzle.size, regions = puzzle.regions, cats = new Set(marks?.cats || []), crosses = new Set(marks?.crosses || []);
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
    const cats = new Set(marks?.cats || []), crosses = new Set(marks?.crosses || []), result = [];
    for (let index = 0; index < puzzle.size * puzzle.size; index++) {
      if (!cats.has(index) && !crosses.has(index) && validPlacement(puzzle.size, puzzle.regions, cats, index)) result.push(index);
    }
    return result;
  }

  function unitName(type, value) {
    return type === 'row' ? `�� ${value + 1} ���` : type === 'column' ? `�� ${value + 1} ����` : `��� ${value + 1}`;
  }

  function combinations(values, count, start = 0, prefix = [], result = []) {
    if (prefix.length === count) { result.push(prefix.slice()); return result; }
    for (let index = start; index <= values.length - (count - prefix.length); index++) {
      prefix.push(values[index]); combinations(values, count, index + 1, prefix, result); prefix.pop();
    }
    return result;
  }

  function nextHint(puzzle, marks) {
    const cats = new Set(marks?.cats || []), crosses = new Set(marks?.crosses || []), open = candidates(puzzle, {cats, crosses});
    // These two checks intentionally consult the stored answer. They only repair
    // player mistakes and are clearly labeled; normal logic below never reads it.
    const wrongCat = Array.isArray(puzzle.solution) ? [...cats].find(index => !puzzle.solution.includes(index)) : null;
    if (wrongCat != null) return {kind:'error',index:wrongCat,related:[wrongCat],technique:'correction',source:'answer-check',text:'�����ˬd�G�o���ߤ��O���D�ѵ����@�����C�Х������o�ӼаO�A�A�~��±��z���ܡC'};
    const wrongCross = Array.isArray(puzzle.solution) ? [...crosses].find(index => puzzle.solution.includes(index)) : null;
    if (wrongCross != null) return {kind:'error',index:wrongCross,related:[wrongCross],technique:'correction',source:'answer-check',text:'�����ˬd�G�o�椣���Q�ư��C�ЦA�I�@�U�M�� X�A�קK�L���L�ѡC'};

    const units = [];
    for (let value = 0; value < puzzle.size; value++) {
      units.push({type:'row',value,cells:open.filter(index => Math.floor(index / puzzle.size) === value),done:[...cats].some(index => Math.floor(index / puzzle.size) === value)});
      units.push({type:'column',value,cells:open.filter(index => index % puzzle.size === value),done:[...cats].some(index => index % puzzle.size === value)});
      units.push({type:'region',value,cells:open.filter(index => puzzle.regions[index] === value),done:[...cats].some(index => puzzle.regions[index] === value)});
    }
    const single = units.find(unit => !unit.done && unit.cells.length === 1);
    if (single) return {kind:'cat',index:single.cells[0],related:single.cells,technique:`${single.type}-single`,source:'logic',text:`${unitName(single.type,single.value)}�u�ѳo�@����ߡC`};

    for (const cat of cats) {
      const row = Math.floor(cat / puzzle.size), col = cat % puzzle.size;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nextRow = row + dr, nextCol = col + dc, index = nextRow * puzzle.size + nextCol;
        if ((dr || dc) && nextRow >= 0 && nextCol >= 0 && nextRow < puzzle.size && nextCol < puzzle.size && !cats.has(index) && !crosses.has(index)) {
          return {kind:'cross',index,related:[cat,index],technique:'adjacent',source:'logic',text:'�ߪ��P��K�泣����A��ߡC'};
        }
      }
    }

    for (const unit of units.filter(value => !value.done && value.cells.length > 1)) {
      const rows = new Set(unit.cells.map(index => Math.floor(index / puzzle.size))), cols = new Set(unit.cells.map(index => index % puzzle.size));
      if (unit.type === 'region' && rows.size === 1) {
        const row = [...rows][0], target = open.find(index => Math.floor(index / puzzle.size) === row && puzzle.regions[index] !== unit.value);
        if (target != null) return {kind:'cross',index:target,related:unit.cells.concat(target),technique:'region-row',source:'logic',text:`��� ${unit.value + 1} ���ߥ��b�� ${row + 1} ��ơA�]���P�ƨ�L��ϥi�ư��C`};
      }
      if (unit.type === 'region' && cols.size === 1) {
        const col = [...cols][0], target = open.find(index => index % puzzle.size === col && puzzle.regions[index] !== unit.value);
        if (target != null) return {kind:'cross',index:target,related:unit.cells.concat(target),technique:'region-column',source:'logic',text:`��� ${unit.value + 1} ���ߥ��b�� ${col + 1} ����A�]���P���L��ϥi�ư��C`};
      }
    }

    // Reverse locked candidates: a row/column confined to one region excludes
    // the rest of that region. This is direct set containment, not trial placement.
    for (const unit of units.filter(value => !value.done && value.cells.length > 1 && value.type !== 'region')) {
      const regions = new Set(unit.cells.map(index => puzzle.regions[index]));
      if (regions.size !== 1) continue;
      const region = [...regions][0], target = open.find(index => puzzle.regions[index] === region &&
        (unit.type === 'row' ? Math.floor(index / puzzle.size) !== unit.value : index % puzzle.size !== unit.value));
      if (target != null) return {kind:'cross',index:target,related:unit.cells.concat(target),technique:`${unit.type}-region`,source:'logic',
        text:`${unitName(unit.type,unit.value)}���ߥ��b��� ${region + 1}�A�]���Ӧ�Ϩ�L${unit.type === 'row' ? '���' : '����'}�i�ư��C`};
    }

    const familyLabel={row:'���',column:'����',region:'���'};
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
        const sourceNames=[...sources].map(value=>value+1).join('�B'),targetNames=[...targets].map(value=>value+1).join('�B');
        return {kind:'cross',index:target,related:group.flatMap(unit=>unit.cells).concat(target),technique:`subset-${width}-${sourceType}-${targetType}`,source:'logic',
          text:`${familyLabel[sourceType]} ${sourceNames} �� ${width} ���ߥu����t�b${familyLabel[targetType]} ${targetNames}�F�o�Ǧ�m�w�Q�O�d�A��L${familyLabel[sourceType]}�i�ư��C`};
      }
    }
    return null;
  }

  function validate(puzzle) {
    const errors = [], size = puzzle?.size, regions = puzzle?.regions;
    if (!Number.isInteger(size) || size < 4 || size > 9) errors.push('invalid size');
    if (!Array.isArray(regions) || regions.length !== size * size) errors.push('invalid regions');
    if (errors.length) return {valid:false,errors,solutions:0};
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
    return {valid:!errors.length,errors,solutions:solutions.length,solution:solutions[0]};
  }

  return {enumerate,candidates,nextHint,validate,validPlacement};
});

