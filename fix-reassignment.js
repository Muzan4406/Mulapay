const fs = require('fs');
let content = fs.readFileSync('artifacts/mulapay/src/App.tsx', 'utf8');

content = content.replace(
  "  const Settings = RealSettings;\n",
  ""
);

fs.writeFileSync('artifacts/mulapay/src/App.tsx', content);
console.log('Update successful');
