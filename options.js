const keyInput = document.getElementById('apiKey');
const modelSelect = document.getElementById('model');
const status = document.getElementById('status');

chrome.storage.local.get(['apiKey', 'model']).then(({ apiKey, model }) => {
  keyInput.value = apiKey || '';
  if (model) modelSelect.value = model;
});

document.getElementById('save').addEventListener('click', async () => {
  const apiKey = keyInput.value.trim();
  if (apiKey) await chrome.storage.local.set({ apiKey, model: modelSelect.value });
  else {
    await chrome.storage.local.remove('apiKey');
    await chrome.storage.local.set({ model: modelSelect.value });
  }
  status.textContent = apiKey ? 'Saved.' : 'Saved. No key set, so Summary and Chat are off.';
});
