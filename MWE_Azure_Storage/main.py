# -------------------------------------------------------------
# 	Terminologia i działanie elementów:
# 		a. Storage accounts (konto magazynu) – nadrzędny kontener w Azure, udostępnia usługi magazynowania. Ma unikatową nazwę i przypisany region Azure. (dla każdego użytkownika własny)
# 		b. Containers – folder logiczny w ramach konta magazynu. Przechowuje bloby (pliki), może mieć zdefiniowany poziom dostępu. (użytkownik może mieć kilka jak np. w przypadku folderów na Google Drive)
# 		c-1. File Storage – udziały sieciowe SMB (Server Message Block), umożliwia montowanie udziału jako folderu np. w Windows, Linux lub macOS.
# 	    c-2. Blob Storage – mechanizm do przechowywania obiektów binarnych (blobów).
#            Typy blobów:
#          - Block blob – pliki ogólnego użytku (np. PDF, JPG, DOCX).
#          - Block blob – logi (można dopisywać na końcu).
#          - Page blob – dyski wirtualne (np. dla maszyn Azure VM).
# 		d. Wersjonowanie plików – funkcja, która pozwala śledzić historię zmian pliku. Azure automatycznie tworzy nową wersję za każdym razem, gdy istniejący plik jest nadpisywany.
#            Na co pozwala (Storage accounts -> Data management -> Data protection -> "Enable versioning for blobs"):
#          - Przywrócić starszą wersję.
#          - Pobrać wcześniejszy stan pliku.
#          - Porównać wersje.
# 		e. Kopie zapasowe:
#          - Soft Delete (Storage accounts -> Data management -> Data protection -> "Enable soft delete for blobs/containers") - działa jak "Bin" w systemach operacyjnych.
#          - Azure Backup (https://learn.microsoft.com/en-us/azure/backup/blob-backup-configure-manage?tabs=operational-backup) - kopie zapasowe operacyjne i archiwalne tworzone w celu chronienia blobów w kontach magazynu.
#          - Systemowe kopie zapasowe są utrzymywane przez Azure automatycznie.
# -------------------------------------------------------------


# ------- BLOB CONTAINERS -------

# 1. Instalacja SDK: pip install azure-storage-blob

from azure.storage.blob import BlobServiceClient, BlobClient

# 2. Połączenie się z kontem za pomocą SAS token-a:

    # Co zarobić w panelu Azure:
    # 1. Stworzyć Resource Group;
    # 2. Stworzyć Storage Account;
    # 3. Stworzyć Blob Container - "dokumenty";
    # 4. Wygenerować Shared Access Signature (SAS).

account_name = "konto123test"
sas_token = "sv=2024-11-04&ss=b&srt=co&sp=rwdlaciytfx&se=2025-10-28T20:12:24Z&st=2025-10-23T11:15:00Z&spr=https&sig=25ba9PqpFLjUhYuO611wVJXobdidmaOlmjPq%2FbBVVnQ%3D"

sas_url = f"https://{account_name}.blob.core.windows.net/?{sas_token}"
blob_service = BlobServiceClient(account_url=sas_url)

# 3. Utworzenie klienta usługi:

container_name = "dokumenty"
container_client = blob_service.get_container_client(container_name)

# 4. Wysyłanie pliku:

plik_lokalny = "raport.pdf"
blob_nazwa = "raport.pdf"

with open(plik_lokalny, "rb") as data:
    container_client.upload_blob(name=blob_nazwa, data=data, overwrite=True)

print(f"Plik '{plik_lokalny}' został wysłany do Azure Blob Storage!")

# 5. Pobieranie pliku z Blob Container-a:

plik_docelowy = "pobrany_raport.pdf"
blob_client = container_client.get_blob_client(blob=blob_nazwa)

with open(plik_docelowy, "wb") as file:
    data = blob_client.download_blob()
    file.write(data.readall())

print(f"Plik '{plik_docelowy}' został pobrany z Azure Blob Storage!")

# 5. Pobieranie listy plików z Blob Container-a:

blob_list = container_client.list_blobs()

print ("Files in the Blob Container: ")
for blob in blob_list:
    print(f"'{blob.name}'")

# 6. Utworzenie nowego Blob Container-a:

# new_container_name = "zdjecia"
# container_client = blob_service.create_container(new_container_name)
#
# print(f"Utworzono nowy kontener: '{new_container_name}'")

# 7. Pobieranie listy wersji pliku z Blob Container-a:

print(f"Lista wersji pliku '{blob_nazwa}':")
for blob in container_client.list_blobs(name_starts_with=blob_nazwa, include=["versions"]): # Metoda list_blobs() nie ma argumentu z konkretną nazwą pliku.
    print(f"Version ID: {blob.version_id}, is_current_version: {blob.is_current_version}")

# 8. Pobieranie poprzedniej wersji pliku:

plik_docelowy = "raport_poprzedni.pdf"
version_id = "2025-10-23T11:24:21.9551328Z"

blob_client_new = BlobClient(
    account_url=sas_url,
    container_name=container_name,
    blob_name=blob_nazwa,
    version_id=version_id
)

with open(plik_docelowy, "wb") as file:
    data = blob_client_new.download_blob()
    file.write(data.readall())

print(f"Plik '{plik_docelowy}' w poprzedniej wersji został pobrany z Azure Blob Storage!")

