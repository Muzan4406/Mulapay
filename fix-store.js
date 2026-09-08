const fs = require('fs');
let content = fs.readFileSync('artifacts/mulapay/src/App.tsx', 'utf8');

content = content.replace(
  "profile: { id: string; firstName: string; lastName: string; email: string; phone?: string; address?: string; role: string; country: string; kycStatus: string };",
  "profile: { id: string; firstName: string; lastName: string; email: string; phone?: string; address?: string; role: string; country: string; kycStatus: string; birthDate?: string | null; language?: string; notificationsEnabled?: boolean; };"
);

fs.writeFileSync('artifacts/mulapay/src/App.tsx', content);
console.log('Update successful');
