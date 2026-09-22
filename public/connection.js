// Only the server address is persisted. Credentials remain in page memory.
window.connectionReady = (async () => {
  window.serviceUrl = path => path;
  if (!location.hostname.endsWith('.github.io')) return;
  const form = document.querySelector('#login-form');
  form.hidden = true;
  const box = document.createElement('section');
  box.innerHTML = '<h2>Подключение к Маркету</h2><p class="muted">Сайт уже открыт на GitHub Pages. Для заказов и переписки подключите серверную часть приложения.</p><label>Адрес вашего сервиса<input type="url" placeholder="https://digital-goods-service.…workers.dev" autocomplete="url"></label><p class="hint">Укажите адрес своего опубликованного сервиса. Только ему будут передаваться введённые ключ и пароль.</p><p class="error-text" role="alert"></p><button type="button" class="button primary wide">Подключить</button><details><summary>Почему нужен ещё один адрес?</summary><p class="hint">GitHub Pages показывает страницы, но не запускает сервер отправки заказов. Серверная часть находится в этом же проекте и размещается отдельно. Инструкция — в файле README.md.</p></details>';
  form.before(box);
  const input = box.querySelector('input'), error = box.querySelector('.error-text'), submit = box.querySelector('button');
  try { input.value = localStorage.getItem('market-service-url') || ''; } catch {}
  await new Promise(resolve => {
    submit.addEventListener('click', async () => {
      submit.disabled = true; error.textContent = '';
      try {
        const url = new URL(input.value.trim());
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw new Error('Укажите HTTPS-адрес сервиса без пути, пароля и дополнительных параметров.');
        const response = await fetch(url.origin + '/api/settings', {cache:'no-store', signal:AbortSignal.timeout(15000)});
        if (!response.ok) throw new Error('Сервис ответил ошибкой. Проверьте его публикацию.');
        const settings = await response.json();
        if (!settings.businessId || !settings.campaignId || typeof settings.passwordRequired !== 'boolean') throw new Error('По этому адресу не найден сервер цифровых заказов.');
        window.serviceUrl = path => url.origin + path;
        try { localStorage.setItem('market-service-url', url.origin); } catch {}
        box.hidden = true; form.hidden = false;
        const label = document.createElement('p'); label.className='hint';label.textContent='Подключён сервис: '+url.hostname;
        const change = document.createElement('button'); change.type='button';change.className='button quiet';change.textContent='Изменить адрес';
        change.onclick=()=>{try{localStorage.removeItem('market-service-url');}catch{}location.reload();};
        label.append(change); form.before(label);
        resolve();
      } catch(e) { error.textContent = e instanceof TypeError ? 'Не удалось подключиться. Проверьте адрес, доступность сервиса и разрешение для вашего сайта GitHub Pages.' : e.message; }
      finally { submit.disabled=false; }
    });
  });
})();
