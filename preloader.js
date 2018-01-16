class Preloader {
    static isFirstVisit() {
        return new Promise(resolve => {
            const request = indexedDB.open('wallet');
            request.onupgradeneeded = function(e) {
                e.target.transaction.abort();
                resolve(true)
            }
            request.onsuccess = function(e) {
                resolve(false)
            }
        })
    }
}
Preloader.isFirstVisit().then(isFirstVisit => location = isFirstVisit ? '#welcome' : '#locked');