export default function handler(_request: any, response: any) {
  response.status(200).json({ ok: true, service: 'avtodrom-api' });
}
