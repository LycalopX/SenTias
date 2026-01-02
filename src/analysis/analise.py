import json

# Carregar os dados que você extraiu
with open('catalogo_new_ultra.json', 'r') as f:
    data = json.load(f)

# Definições de busca técnica
keywords = {
    "MINT": ["美品", "極美品", "未使用に近い"], # Estado de colecionador
    "IPS": ["ips"], # Telas superiores
    "SOFTWARE_ISSUE": ["起動しない", "エラー", "prefetch", "進まない"], # Alvos de engenharia (não liga/erro)
    "PHYSICAL_DAMAGE": ["液晶割れ", "ヒンジ割れ", "割れ", "カビ", "液漏れ"] # Lixo físico para evitar
}

shortlist = []

for item in data:
    nome = item['nome'].lower()
    desc = item['descricao'].lower()
    preco = item['preco_iene']
    
    # Identificar categorias
    is_mint = any(w in desc or w in nome for w in keywords["MINT"])
    is_ips = any(w in desc or w in nome for w in keywords["IPS"])
    has_soft_err = any(w in desc or w in nome for w in keywords["SOFTWARE_ISSUE"])
    has_damage = any(w in desc or w in nome for w in keywords["PHYSICAL_DAMAGE"])
    
    # Nossa lógica de filtro:
    # Queremos: Itens MINT abaixo de 25k OU Soft Error barato OU qualquer IPS
    if not has_damage: # Descarta o lixo físico primeiro
        score = 0
        tag = "Comum"
        
        if is_mint: 
            tag = "COLECIONADOR"
            score += 2
        if is_ips: 
            tag = "IPS SCREEN (PREMIUM)"
            score += 5
        if has_soft_err: 
            tag = "PROJETO ENGENHARIA"
            score += 3
            
        shortlist.append({
            "nome": item['nome'],
            "preco": preco,
            "tag": tag,
            "url": item['url'],
            "score": score
        })

# Ordenar por Score (relevância) e depois por Preço
shortlist.sort(key=lambda x: (-x['score'], x['preco']))

# Printar os TOP 20 resultados para você bater o martelo
print(f"--- Shortlist de Oportunidades ({len(shortlist)} itens filtrados) ---")
for i, c in enumerate(shortlist[:20]):
    print(f"{i+1}. [¥{c['preco']}] {c['tag']} - {c['nome'][:50]}...")
    print(f"   Link: {c['url']}\n")