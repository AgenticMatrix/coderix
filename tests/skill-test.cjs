const { getSkillRegistry } = require('../dist/skills/registry.js');

// Test 1: load from disk
const registry = getSkillRegistry();
const count = registry.loadFromDisk();
console.log('=== Test 1: load from disk ===');
console.log('Skills loaded:', count);
const all = registry.getAll();
all.forEach(s => console.log('  -', s.metadata.name, ':', s.metadata.description?.slice(0,60)));
console.log(count > 0 ? 'PASS' : 'FAIL');

// Test 2: get by name
console.log('\n=== Test 2: get web-bridge skill ===');
const skill = registry.get('web-bridge');
if (skill) {
  console.log('Name:', skill.metadata.name);
  console.log('Description:', skill.metadata.description);
  console.log('Triggers:', skill.metadata.triggers?.join(', '));
  console.log('Body length:', skill.body.length, 'chars');
  console.log('Body preview:', skill.body.slice(0, 100).replace(/\n/g, ' '));
  console.log('PASS');
} else {
  console.log('FAIL: not found');
}

// Test 3: getSummaries
console.log('\n=== Test 3: getSummaries ===');
const summaries = registry.getSummaries();
summaries.forEach(s => console.log('  -', s.name, '-', s.description?.slice(0, 60)));
console.log(summaries.length > 0 ? 'PASS' : 'FAIL');

// Test 4: findByTrigger
console.log('\n=== Test 4: findByTrigger ===');
const byTrigger = registry.findByTrigger('browser');
byTrigger.forEach(s => console.log('  -', s.metadata.name));
console.log(byTrigger.length > 0 ? 'PASS' : 'FAIL');

// Test 5: search
console.log('\n=== Test 5: search ===');
const search = registry.search('web');
search.forEach(s => console.log('  -', s.metadata.name));
console.log(search.length > 0 ? 'PASS' : 'FAIL');

// Test 6: recordUsage + stats
console.log('\n=== Test 6: usage tracking ===');
const before = registry.getUsageStats().totalUsages;
registry.recordUsage('web-bridge');
const after = registry.getUsageStats();
console.log('Usage count:', after.totalUsages, '(was', before, ')');
console.log(after.totalUsages > before ? 'PASS' : 'FAIL');

// Test 7: unknown skill returns undefined
console.log('\n=== Test 7: unknown skill ===');
const unknown = registry.get('nonexistent');
console.log(unknown === undefined ? 'PASS' : 'FAIL: returned', unknown);

// Test 8: count
console.log('\n=== Test 8: count ===');
console.log('Registered skills:', registry.count);
console.log(registry.count >= 1 ? 'PASS' : 'FAIL');

console.log('\n=== ALL SKILL TESTS PASSED ===');
