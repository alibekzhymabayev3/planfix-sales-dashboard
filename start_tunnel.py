import time
from pyngrok import ngrok

print("Starting ngrok...")
public_url = ngrok.connect(8000)
print("NGROK_URL: ", public_url.public_url)

while True:
    time.sleep(10)
