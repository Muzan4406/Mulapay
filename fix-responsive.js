const fs = require('fs');
let content = fs.readFileSync('artifacts/mulapay/src/App.tsx', 'utf8');

content = content.replaceAll(
  "style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}",
  "style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}"
);

fs.writeFileSync('artifacts/mulapay/src/App.tsx', content);
console.log('Update successful');
