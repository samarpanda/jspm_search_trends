import jsonp from 'jsonp';

class SearchTrendsApi{
	constructor(){
		this.googleURL = "https://morning-river-6203.herokuapp.com/google_trends";
	}
	load(){
		return new Promise((resolve, reject) => {
			jsonp(this.googleURL, {param: 'callback'}, (err, data) => {
				err ? reject(err) : resolve(data);
			});
		});
	}
}

export default new SearchTrendsApi();