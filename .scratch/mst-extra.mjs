import { types, applySnapshot } from 'mobx-state-tree'
const M = types.model({ id: types.identifier, a: types.string })
const C = types.model({ items: types.map(M) })
const c = C.create({ items: {} })
try { c.items.put({ id: 'x', a: 'hi', updatedAt: '2026-01-01' }); console.log('put ok', JSON.stringify(c.items.get('x'))) } catch (e) { console.log('put threw:', e.message) }
try { const i = M.create({ id: 'y', a: 'z' }); applySnapshot(i, { id: 'y', a: 'q', updatedAt: 'x' }); console.log('snapshot ok') } catch (e) { console.log('snapshot threw:', e.message) }
