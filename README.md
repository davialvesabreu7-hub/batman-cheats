# BATMAN CHEATS — servidor inicial

Este projeto é um ponto de partida para:
- salvar pedidos em SQLite;
- criar um Pix BR Code com valor fixo por produto e QR Code;
- enviar e-mail de pedido se SMTP estiver configurado;
- oferecer painel administrativo protegido por senha;
- permitir confirmação manual do pagamento e enviar instruções por e-mail.

## Requisitos
- Node.js 20 ou superior.
- Hospedagem que permita processo Node.js e armazenamento persistente para `data/orders.sqlite`.
- Um serviço SMTP de e-mail.
- Uma chave Pix e os dados do titular.

## Rodar localmente
1. Instale Node.js 20+.
2. Extraia o projeto.
3. Copie `.env.example` para `.env`.
4. Preencha `ADMIN_PASSWORD`, `PIX_KEY`, `PIX_RECEIVER_NAME` e `PIX_RECEIVER_CITY`.
5. Configure SMTP para enviar e-mails. Nunca use a senha normal de uma conta de e-mail; use credenciais SMTP/app password fornecidas pelo provedor.
6. No terminal, dentro da pasta do projeto:
   ```bash
   npm install
   npm start
   ```
7. Abra `http://localhost:3000`.

## Integração com o HTML
O arquivo `public/index.html` chama `POST /api/orders` para criar pedidos. O endpoint retorna QR e Pix copia-e-cola quando a configuração Pix está completa. Sem essas variáveis, o pedido fica salvo, mas o site informa que falta configurar Pix.

## Painel administrativo
O arquivo `public/admin.html` é o painel protegido. A senha vem de `ADMIN_PASSWORD` no servidor. Depois de entrar, carregue pedidos e clique em “Confirmar pagamento” somente após verificar o crédito no aplicativo bancário. A sessão expira em 8 horas.

## Hospedagem
Escolha um host que execute Node.js e ofereça disco persistente. Em algumas hospedagens gratuitas, o sistema de arquivos é temporário e o SQLite pode ser apagado em reinicializações/deploys. Nesse caso, use banco de dados gerenciado (por exemplo PostgreSQL) ou um plano com disco persistente. Configure as variáveis do `.env` no painel da hospedagem em vez de subir o arquivo `.env`.

## Atenção importante sobre Pix
O gerador monta um BR Code Pix estático com valor e TXID para cada pedido. Ele não consulta o banco nem confirma automaticamente o pagamento. O TXID no QR Code não garante que o aplicativo bancário vai mostrar a referência da forma esperada. Faça um teste de baixo valor e confira os dados do recebedor antes de divulgar. Nunca marque pago com base em comprovante enviado pelo comprador; confira o crédito real na sua conta.

## Privacidade e segurança
- Não colete senha do e-mail, senha bancária ou dados de login dos compradores.
- O CPF não foi incluído no formulário porque não é necessário para este fluxo básico.
- Publique uma política de privacidade, informe a finalidade dos dados e mantenha acesso restrito.
- Para uso comercial, revise a legislação aplicável e as regras da instituição financeira.
- Este projeto é um starter; revise-o e teste-o antes de colocar em produção.
