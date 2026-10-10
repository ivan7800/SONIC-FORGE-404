from ai_bridge import gpu_report
import json
print(json.dumps(gpu_report(), indent=2, ensure_ascii=False))
print('\nNOTA: detectar una GPU no garantiza que ACE-Step sea compatible con sus controladores.')
