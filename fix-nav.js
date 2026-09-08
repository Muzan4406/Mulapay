const fs = require('fs');
let content = fs.readFileSync('artifacts/mulapay/src/App.tsx', 'utf8');

content = content.replace(
  "location === '/app/settings' ? 'Profil' : admin",
  "location === '/app/settings' ? 'Compte' : admin"
);

content = content.replace(
  '<Link href="/app/settings" className={`nav-link ${location === \'/app/settings\' ? \'active\' : \'\'}`} data-testid="link-nav-settings"><img className="nav-image" src={dashboardIcon(\'profile.png\')} alt="" /><span>Profil</span></Link>',
  '<Link href="/app/settings" className={`nav-link ${location === \'/app/settings\' ? \'active\' : \'\'}`} data-testid="link-nav-settings"><img className="nav-image" src={dashboardIcon(\'profile.png\')} alt="" /><span>Compte</span></Link>'
);

fs.writeFileSync('artifacts/mulapay/src/App.tsx', content);
console.log('Update successful');
