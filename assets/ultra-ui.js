(function (root) {
  'use strict';
  const $ = id => document.getElementById(id), esc = root.AvtodromCore.escape;
  const paths = {
    dashboard:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    bookings:'M5 5h14v16H5z M8 3v4 M16 3v4 M5 10h14 M8 14h3 M8 17h7',
    live:'M3 12h4l3-7 4 14 3-7h4',
    reports:'M4 20V4 M4 20h17 M8 16v-5 M13 16V7 M18 16v-9',
    users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M20 21v-2a4 4 0 0 0-3-3.9',
    manual:'M12 5v14 M5 12h14',
    checkout:'M5 3h14v18l-3-2-4 2-4-2-3 2z M8 7h8 M8 11h8 M8 15h4',
    settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
    payments:'M3 6h18v14H3z M3 10h18 M15 15h3',
    audit:'M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h5',
    search:'M21 21l-5-5 M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14',
    menu:'M4 6h16 M4 12h16 M4 18h16',
    back:'M15 5l-7 7 7 7',
    forward:'M5 12h14 M13 6l6 6-6 6',
    user:'M20 21v-2a7 7 0 0 0-14 0v2 M13 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
    lock:'M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0v3 M12 14v3',
    eye:'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12 M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
    eyeOff:'M3 3l18 18 M10 5.2A11 11 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.4 4.2 M6 6.8A18 18 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5-1.1 M10 10a3 3 0 0 0 4 4',
    refresh:'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 3 M4 15l2 3a7 7 0 0 0 12-1',
    exit:'M9 3H4v18h5 M12 12h9 M17 8l4 4-4 4',
    shield:'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
    support:'M21 11.5a8 8 0 0 1-11.7 7.1L4 20l1.3-4.5A8 8 0 1 1 21 11.5z',
  };
  const aliases = {kdash:'reports',klive:'live',cashier:'bookings',control:'users',insacc:'reports',applications:'audit',cancels:'audit',instructors:'users',courses:'bookings',reviews:'audit',media:'dashboard',staff:'users'};
  function icon(name) { return `<svg class="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="${paths[aliases[name] || name] || paths.dashboard}"/></svg>`; }
  function confirmAction({ title, message, confirmLabel = 'Tasdiqlash', reasonLabel, danger = false }) {
    if (document.querySelector('#ultraConfirm[open]')) return Promise.resolve(null);
    const previous = document.activeElement;
    const d = document.createElement('dialog'); d.id = 'ultraConfirm'; d.className = 'ultra-dialog';
    d.setAttribute('aria-labelledby','ultraConfirmTitle');
    d.innerHTML = `<h2 id="ultraConfirmTitle">${esc(title)}</h2><p>${esc(message)}</p>${reasonLabel ? `<label for="ultraReason">${esc(reasonLabel)}</label><textarea id="ultraReason" rows="3" maxlength="1000"></textarea>` : ''}<div class="dialog-actions"><button type="button" class="btn" data-answer="no" autofocus>Orqaga</button><button type="button" class="btn ${danger ? 'red' : 'primary'}" data-answer="yes">${esc(confirmLabel)}</button></div>`;
    document.body.append(d);
    return new Promise(resolve => {
      let settled = false;
      function finish(value) { if(settled)return; settled=true; d.remove(); previous?.focus?.(); resolve(value); }
      d.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
      d.querySelector('[data-answer="no"]').onclick=()=>finish(null);
      d.querySelector('[data-answer="yes"]').onclick=()=>finish({reason:d.querySelector('textarea')?.value.trim() || ''});
      if (typeof d.showModal === 'function') d.showModal();
      else { d.remove(); if(!window.confirm(title+'\n\n'+message)) return finish(null); const reason=reasonLabel?window.prompt(reasonLabel,''):''; finish(reason===null?null:{reason}); }
    });
  }
  function connection(state, message) {
    const el=$('ultraConnection'); if(!el)return;
    el.dataset.state=state; el.querySelector('span:last-child').textContent=message;
  }
  function page(id) {
    const heading=document.querySelector('#'+id+' .head h1');
    if($('ultraPageName')) $('ultraPageName').textContent=heading?.textContent || 'Ish maydoni';
    document.querySelectorAll('.nav').forEach(b=>b.setAttribute('aria-current',b.dataset.p===id?'page':'false'));
    document.body.classList.remove('menu-open'); $('ultraMenu')?.setAttribute('aria-expanded','false');
    if(heading) { heading.setAttribute('tabindex','-1'); }
  }
  function passwordVisible(visible) {
    const input=$('loginPass'), toggle=$('loginPassToggle');
    if(!input || !toggle)return;
    input.type=visible?'text':'password';
    const label=visible?'Parolni yashirish':'Parolni ko‘rsatish';
    toggle.setAttribute('aria-pressed',String(visible));
    toggle.setAttribute('aria-label',label);
    toggle.title=label;
    toggle.querySelector('[data-password-icon]').innerHTML=icon(visible?'eyeOff':'eye');
  }
  function loginStep(role) {
    const form=$('loginForm'); if(!form)return;
    form.dataset.role=role || '';
    if($('roleNowIcon'))$('roleNowIcon').innerHTML=icon(role==='admin'?'shield':'checkout');
    passwordVisible(false);
    if($('loginPass'))$('loginPass').value='';
  }
  function initAdmin({navigate,refresh}) {
    document.querySelectorAll('.nav[data-p]').forEach(b=>b.insertAdjacentHTML('afterbegin',icon(b.dataset.p)));
    document.querySelectorAll('[data-ultra-icon]').forEach(el=>el.insertAdjacentHTML('afterbegin',icon(el.dataset.ultraIcon)));
    $('loginPassToggle')?.addEventListener('click',()=>passwordVisible($('loginPass').type==='password'));
    const time=$('ultraDate'); if(time)time.textContent=new Intl.DateTimeFormat('uz-UZ',{timeZone:'Asia/Tashkent',day:'numeric',month:'long',year:'numeric'}).format(new Date());
    document.querySelectorAll('[data-shortcut]').forEach(el=>el.onclick=()=>navigate(el.dataset.shortcut));
    function closeMenu(){document.body.classList.remove('menu-open');$('ultraMenu').setAttribute('aria-expanded','false');}
    $('ultraMenu').onclick=()=>{const open=document.body.classList.toggle('menu-open');$('ultraMenu').setAttribute('aria-expanded',String(open));if(open)document.querySelector('.side .nav:not(.hidden)')?.focus();};
    $('ultraScrim').onclick=closeMenu;
    const dialog=$('ultraCommands'), input=$('ultraCommandInput'), list=$('ultraCommandList');
    function commands(){
      const query=input.value.trim().toLocaleLowerCase();
      const allowed=[...document.querySelectorAll('.nav[data-p]:not(.hidden)')].filter(el=>!el.disabled);
      const matches=allowed.filter(el=>el.textContent.toLocaleLowerCase().includes(query));
      list.innerHTML=matches.length?matches.map(el=>`<button type="button" data-go="${esc(el.dataset.p)}">${icon(el.dataset.p)}<span>${esc(el.textContent.trim())}</span></button>`).join(''):'<p>Bo‘lim topilmadi. Boshqa nom bilan qidiring.</p>';
      list.querySelectorAll('[data-go]').forEach(el=>el.onclick=()=>{dialog.close();navigate(el.dataset.go);});
    }
    function openCommands(){if($('app').classList.contains('hidden'))return;input.value='';commands();dialog.showModal();input.focus();}
    $('ultraSearch').onclick=openCommands; $('ultraCommandClose').onclick=()=>dialog.close(); input.oninput=commands;
    input.onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();list.querySelector('button')?.focus();}if(e.key==='Enter'){e.preventDefault();list.querySelector('button')?.click();}};
    list.onkeydown=e=>{const buttons=[...list.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}};
    document.addEventListener('keydown', e=>{
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openCommands();}
      if(e.key==='Escape'&&document.body.classList.contains('menu-open')){closeMenu();$('ultraMenu').focus();}
    });
    document.querySelectorAll('input,select,textarea').forEach(el=>{
      if(el.getAttribute('aria-label')||el.labels?.length)return;
      const label=el.closest('.field')?.querySelector('label')?.textContent||el.getAttribute('placeholder')||el.id;
      if(label)el.setAttribute('aria-label',label);
    });
    $('refreshBtn').onclick=()=>refresh(true);
    window.addEventListener('offline',()=>connection('error','Aloqa uzilgan'));
  }
  root.AvtodromUI = {icon,confirmAction,connection,page,initAdmin,loginStep};
})(globalThis);
