import SearchTrendsApi from './search-trends-api';
import TrendsItem from './trends-item';
import TrendsView from './trends-view';

SearchTrendsApi.load()
	.then(TrendsItem, function(err){
		console.log("TrendsItem Error: ", err);
	})
	.then(TrendsView, function(err){
		console.log("TrendsView Error: ", err);
	});

export default {};